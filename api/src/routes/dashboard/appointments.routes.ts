import { type Request, type Response } from 'express';
import { z } from 'zod';
import { auditAction, auditRequired } from '../../auth/audit';
import { requirePermission } from '../../auth/middleware';
import { prisma } from '../../lib/prisma';
import { formatInTimezone, getClinicTimezone } from '../../lib/timezone';
import {
  AppointmentCommandError,
  cancelAppointmentCommand,
  createAppointmentCommand,
  rescheduleAppointmentCommand,
} from '../../services/appointmentCommands';
import { createRouter } from '../../lib/asyncRouter';
import { publicClinicSelect } from '../../services/publicClinic';

const router = createRouter();

const appointmentIdSchema = z.string().uuid();
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const doctorIdSchema = z.preprocess(
  value => (value === '' || value === null ? undefined : value),
  z.string().uuid().optional()
);
const listQuerySchema = z.object({
  tab: z.enum(['upcoming', 'past', 'cancelled']).default('upcoming'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
const createSchema = z.object({
  patientName: z.string().trim().min(2).max(120),
  patientPhone: z.string().trim().min(7).max(30),
  date: dateSchema,
  time: z.string().trim().min(1).max(20),
  reason: z.string().trim().min(1).max(500),
  doctorId: doctorIdSchema,
}).strict();
const rescheduleSchema = z.object({
  newDate: dateSchema,
  newTime: z.string().trim().min(1).max(20),
  doctorId: doctorIdSchema,
}).strict();

function requestIdempotencyKey(req: Request): string | null {
  const value = req.header('idempotency-key')?.trim();
  return value && /^[A-Za-z0-9._:-]{8,200}$/.test(value) ? value : null;
}

function sendCommandError(res: Response, error: unknown) {
  if (!(error instanceof AppointmentCommandError)) {
    console.error('Appointment command failed', {
      message: error instanceof Error ? error.message : 'unknown error',
    });
    return res.status(500).json({ error: 'Appointment operation failed' });
  }
  const status =
    error.code === 'not_found' ? 404 :
    error.code === 'invalid_input' ? 400 :
    error.code === 'commercial_access' ? 402 :
    error.code === 'organization_inactive' ? 403 : 409;
  return res.status(status).json({ error: error.message, code: error.code });
}

router.get('/dashboard/appointments', requirePermission('phi:read'), async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid appointment query' });
  const { tab, page, limit } = parsed.data;
  const organizationId = req.auth!.organizationId;
  const clinicId = req.auth!.clinicId;
  const now = new Date();
  const base = { organizationId, clinicId };
  const where = tab === 'upcoming'
    ? { ...base, startAt: { gte: now }, status: { in: ['scheduled', 'confirmed'] } }
    : tab === 'past'
      ? { ...base, endAt: { lt: now }, status: { in: ['scheduled', 'confirmed', 'completed'] } }
      : { ...base, status: 'cancelled' };

  const [appointments, total, timezone] = await Promise.all([
    prisma.appointment.findMany({
      where,
      include: { patient: true, doctor: true, clinic: { select: publicClinicSelect } },
      orderBy: tab === 'upcoming' ? { startAt: 'asc' } : { startAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.appointment.count({ where }),
    getClinicTimezone(clinicId),
  ]);

  await auditRequired(req, 'phi.appointments_list_viewed', {
    targetType: 'Appointment',
    metadata: { page, resultCount: appointments.length, tab },
  });
  return res.json({ appointments, total, page, limit, tab, timezone });
});

router.get('/dashboard/appointments/:id', requirePermission('phi:read'), async (req, res) => {
  const id = appointmentIdSchema.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: 'Invalid appointment ID' });
  const appointment = await prisma.appointment.findFirst({
    where: {
      id: id.data,
      organizationId: req.auth!.organizationId,
      clinicId: req.auth!.clinicId,
    },
    include: {
      patient: true,
      doctor: true,
      clinic: { select: publicClinicSelect },
      callLogs: true,
      reminderJobs: true,
    },
  });
  if (!appointment) return res.status(404).json({ error: 'Appointment not found' });
  await auditRequired(req, 'phi.appointment_viewed', {
    targetType: 'Appointment',
    targetId: appointment.id,
  });
  return res.json(appointment);
});

router.post('/dashboard/appointments', requirePermission('appointments:write'), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid appointment details' });
  const idempotencyKey = requestIdempotencyKey(req);
  if (!idempotencyKey) {
    return res.status(400).json({
      error: 'A stable Idempotency-Key header (8-200 letters, numbers, dot, colon, underscore, or dash) is required',
    });
  }

  try {
    const result = await createAppointmentCommand({
      organizationId: req.auth!.organizationId,
      clinicId: req.auth!.clinicId,
      ...parsed.data,
      idempotencyKey,
      source: 'dashboard',
    });
    const timezone = await getClinicTimezone(req.auth!.clinicId);
    const { readableDate, readableTime } = formatInTimezone(result.appointment.startAt, timezone);
    await auditAction(req, result.duplicate ? 'appointment.create_replayed' : 'appointment.created', {
      targetType: 'Appointment',
      targetId: result.appointment.id,
      metadata: { calendarSyncStatus: result.appointment.calendarSyncStatus },
    });
    return res.status(result.duplicate ? 200 : 201).json({
      success: true,
      appointment: result.appointment,
      duplicate: result.duplicate,
      sideEffectsPending: result.appointment.calendarSyncStatus !== 'synced',
      message: `Booked for ${readableDate} at ${readableTime}. Calendar and patient notification are processing.`,
    });
  } catch (error) {
    return sendCommandError(res, error);
  }
});

router.patch('/dashboard/appointments/:id/reschedule', requirePermission('appointments:write'), async (req, res) => {
  const id = appointmentIdSchema.safeParse(req.params.id);
  const parsed = rescheduleSchema.safeParse(req.body);
  const idempotencyKey = requestIdempotencyKey(req);
  if (!id.success || !parsed.success) return res.status(400).json({ error: 'Invalid reschedule details' });
  if (!idempotencyKey) return res.status(400).json({ error: 'A stable Idempotency-Key header is required' });

  try {
    const result = await rescheduleAppointmentCommand({
      organizationId: req.auth!.organizationId,
      clinicId: req.auth!.clinicId,
      appointmentId: id.data,
      ...parsed.data,
      idempotencyKey,
      source: 'dashboard',
    });
    const timezone = await getClinicTimezone(req.auth!.clinicId);
    const { readableDate, readableTime } = formatInTimezone(result.appointment.startAt, timezone);
    await auditAction(req, result.duplicate ? 'appointment.reschedule_replayed' : 'appointment.rescheduled', {
      targetType: 'Appointment',
      targetId: result.appointment.id,
      metadata: { previousAppointmentId: result.previousAppointmentId },
    });
    return res.json({
      success: true,
      appointment: result.appointment,
      duplicate: result.duplicate,
      sideEffectsPending: result.appointment.calendarSyncStatus !== 'synced',
      message: `Rescheduled to ${readableDate} at ${readableTime}. Calendar and patient notification are processing.`,
    });
  } catch (error) {
    return sendCommandError(res, error);
  }
});

router.patch('/dashboard/appointments/:id/cancel', requirePermission('appointments:write'), async (req, res) => {
  const id = appointmentIdSchema.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: 'Invalid appointment ID' });
  try {
    const result = await cancelAppointmentCommand({
      organizationId: req.auth!.organizationId,
      clinicId: req.auth!.clinicId,
      appointmentId: id.data,
    });
    await auditAction(req, result.duplicate ? 'appointment.cancel_replayed' : 'appointment.cancelled', {
      targetType: 'Appointment',
      targetId: id.data,
    });
    return res.json({
      success: true,
      duplicate: result.duplicate,
      message: result.duplicate
        ? 'Appointment was already cancelled.'
        : 'Appointment cancelled. Calendar cleanup and patient notification are processing.',
    });
  } catch (error) {
    return sendCommandError(res, error);
  }
});

export default router;
