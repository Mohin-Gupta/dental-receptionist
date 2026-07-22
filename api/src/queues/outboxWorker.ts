import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { formatInTimezone } from '../lib/timezone';
import { createCalendarEvent, deleteCalendarEvent } from '../services/googleCalendar';
import { sendSMS } from '../services/twilio';
import { cancelReminders, scheduleReminders } from './reminderQueue';

type ClaimedOutboxEvent = {
  id: string;
  organizationId: string;
  clinicId: string | null;
  eventType: string;
  payload: Prisma.JsonValue;
  attempts: number;
};

const MAX_ATTEMPTS = 12;
const BATCH_SIZE = 10;

function payloadString(payload: Prisma.JsonValue, key: string): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value ? value : null;
}

function isNotFound(error: unknown): boolean {
  const candidate = error as { code?: number | string; response?: { status?: number } };
  return candidate?.code === 404 || candidate?.code === '404' || candidate?.response?.status === 404;
}

async function syncCalendarForAppointment(appointment: {
  id: string;
  clinicId: string;
  doctorId: string;
  googleEventId: string | null;
  patient: { name: string; phone: string };
  reason: string;
  startAt: Date;
  endAt: Date;
}) {
  if (appointment.googleEventId) return appointment.googleEventId;
  try {
    const googleEventId = await createCalendarEvent(appointment.clinicId, {
      doctorId: appointment.doctorId,
      patientName: appointment.patient.name,
      patientPhone: appointment.patient.phone,
      reason: appointment.reason,
      startAt: appointment.startAt.toISOString(),
      endAt: appointment.endAt.toISOString(),
      idempotencyKey: `appointment:${appointment.id}:google-calendar:v1`,
      appointmentReference: appointment.id,
    });
    await prisma.appointment.update({
      where: { id: appointment.id },
      data: { googleEventId, calendarSyncStatus: 'synced' },
    });
    return googleEventId;
  } catch (error) {
    await prisma.appointment.updateMany({
      where: { id: appointment.id },
      data: { calendarSyncStatus: 'failed' },
    });
    throw error;
  }
}

async function sendCreatedNotification(appointment: Awaited<ReturnType<typeof loadAppointment>>) {
  if (!appointment) return;
  const { readableDate, readableTime } = formatInTimezone(
    appointment.startAt,
    appointment.clinic.timezone
  );
  await sendSMS(
    {
      organizationId: appointment.organizationId,
      clinicId: appointment.clinicId,
      appointmentId: appointment.id,
      patientId: appointment.patientId,
      idempotencyKey: `appointment:${appointment.id}:booking-confirmation:sms:v1`,
      purpose: 'booking_confirmation',
      defaultCallingCode: appointment.clinic.defaultCallingCode,
    },
    appointment.patient.phone,
    `Your appointment at ${appointment.clinic.name} has been confirmed for ` +
      `${readableDate} at ${readableTime}. ` +
      'Please call us if you need to reschedule. Reply STOP to opt out.'
  );
}

async function sendRescheduledNotification(appointment: Awaited<ReturnType<typeof loadAppointment>>) {
  if (!appointment) return;
  const { readableDate, readableTime } = formatInTimezone(
    appointment.startAt,
    appointment.clinic.timezone
  );
  await sendSMS(
    {
      organizationId: appointment.organizationId,
      clinicId: appointment.clinicId,
      appointmentId: appointment.id,
      patientId: appointment.patientId,
      idempotencyKey: `appointment:${appointment.id}:rescheduled:sms:v1`,
      purpose: 'appointment_rescheduled',
      defaultCallingCode: appointment.clinic.defaultCallingCode,
    },
    appointment.patient.phone,
    `Your appointment at ${appointment.clinic.name} has been rescheduled ` +
      `to ${readableDate} at ${readableTime}. ` +
      'Please call us if this does not work for you. Reply STOP to opt out.'
  );
}

async function sendCancelledNotification(appointment: Awaited<ReturnType<typeof loadAppointment>>) {
  if (!appointment) return;
  const { readableDate, readableTime } = formatInTimezone(
    appointment.startAt,
    appointment.clinic.timezone
  );
  await sendSMS(
    {
      organizationId: appointment.organizationId,
      clinicId: appointment.clinicId,
      appointmentId: appointment.id,
      patientId: appointment.patientId,
      idempotencyKey: `appointment:${appointment.id}:cancelled:sms:v1`,
      purpose: 'appointment_cancelled',
      defaultCallingCode: appointment.clinic.defaultCallingCode,
    },
    appointment.patient.phone,
    `Your appointment at ${appointment.clinic.name} ` +
      `on ${readableDate} at ${readableTime} has been cancelled. ` +
      'Please call us to rebook. Reply STOP to opt out.'
  );
}

function loadAppointment(appointmentId: string) {
  return prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: { patient: true, clinic: true },
  });
}

async function runSideEffects(tasks: Array<() => Promise<unknown>>) {
  const results = await Promise.allSettled(tasks.map(task => task()));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length > 0) {
    throw new Error(`${failures.length} appointment projection(s) failed`);
  }
}

async function processCreated(appointmentId: string) {
  const appointment = await loadAppointment(appointmentId);
  if (!appointment || !['scheduled', 'confirmed'].includes(appointment.status)) return;
  await runSideEffects([
    () => syncCalendarForAppointment(appointment),
    () => sendCreatedNotification(appointment),
    () => scheduleReminders(appointment.id),
  ]);
}

async function processRescheduled(appointmentId: string, previousAppointmentId: string) {
  const [appointment, previous] = await Promise.all([
    loadAppointment(appointmentId),
    loadAppointment(previousAppointmentId),
  ]);
  if (!appointment || !['scheduled', 'confirmed'].includes(appointment.status)) return;

  // The replacement is committed locally already. Create its provider event
  // before removing the old event so a transient failure never loses both.
  await syncCalendarForAppointment(appointment);
  await runSideEffects([
    async () => {
      if (!previous?.googleEventId) return;
      try {
        await deleteCalendarEvent(previous.clinicId, previous.googleEventId, previous.doctorId);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      await prisma.appointment.updateMany({
        where: { id: previous.id },
        data: { googleEventId: null, calendarSyncStatus: 'synced' },
      });
    },
    () => cancelReminders(previousAppointmentId),
    () => scheduleReminders(appointment.id),
    () => sendRescheduledNotification(appointment),
  ]);
}

async function processCancelled(appointmentId: string) {
  const appointment = await loadAppointment(appointmentId);
  if (!appointment) return;
  await runSideEffects([
    async () => {
      if (!appointment.googleEventId) return;
      try {
        await deleteCalendarEvent(appointment.clinicId, appointment.googleEventId, appointment.doctorId);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      await prisma.appointment.updateMany({
        where: { id: appointment.id },
        data: { googleEventId: null, calendarSyncStatus: 'synced' },
      });
    },
    () => cancelReminders(appointment.id),
    () => sendCancelledNotification(appointment),
  ]);
}

async function processEvent(event: ClaimedOutboxEvent) {
  const appointmentId = payloadString(event.payload, 'appointmentId');
  if (!appointmentId) throw new Error('Appointment outbox payload is invalid');
  if (event.eventType === 'appointment.created') return processCreated(appointmentId);
  if (event.eventType === 'appointment.cancelled') return processCancelled(appointmentId);
  if (event.eventType === 'appointment.rescheduled') {
    const previousAppointmentId = payloadString(event.payload, 'previousAppointmentId');
    if (!previousAppointmentId) throw new Error('Reschedule outbox payload is invalid');
    return processRescheduled(appointmentId, previousAppointmentId);
  }
  throw new Error(`Unsupported outbox event type: ${event.eventType}`);
}

async function claimBatch(workerId: string): Promise<ClaimedOutboxEvent[]> {
  return prisma.$transaction(async tx => {
    const staleBefore = new Date(Date.now() - 5 * 60 * 1000);
    await tx.outboxEvent.updateMany({
      where: {
        status: 'processing',
        lockedAt: { lt: staleBefore },
        attempts: { gte: MAX_ATTEMPTS },
      },
      data: {
        status: 'dead_letter',
        lockedAt: null,
        lockedBy: null,
        lastError: 'Worker lease expired after the maximum number of attempts',
      },
    });
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT candidate."id"
      FROM "OutboxEvent" candidate
      WHERE (
          (
            candidate."status" IN ('pending', 'failed')
            AND candidate."availableAt" <= NOW()
          )
          OR (
            candidate."status" = 'processing'
            AND candidate."lockedAt" < ${staleBefore}
          )
        )
        AND candidate."eventType" IN ('appointment.created', 'appointment.rescheduled', 'appointment.cancelled')
        AND candidate."attempts" < ${MAX_ATTEMPTS}
        AND NOT EXISTS (
          SELECT 1
          FROM "OutboxEvent" earlier
          WHERE earlier."organizationId" = candidate."organizationId"
            AND earlier."aggregateType" = candidate."aggregateType"
            AND earlier."aggregateId" = candidate."aggregateId"
            AND earlier."status" IN ('pending', 'failed', 'processing')
            AND (earlier."createdAt", earlier."id") < (candidate."createdAt", candidate."id")
        )
      ORDER BY candidate."createdAt", candidate."id"
      FOR UPDATE SKIP LOCKED
      LIMIT ${BATCH_SIZE}
    `);
    if (rows.length === 0) return [];
    const ids = rows.map(row => row.id);
    await tx.outboxEvent.updateMany({
      where: { id: { in: ids } },
      data: {
        status: 'processing',
        lockedAt: new Date(),
        lockedBy: workerId,
        attempts: { increment: 1 },
      },
    });
    return tx.outboxEvent.findMany({
      where: { id: { in: ids }, lockedBy: workerId, status: 'processing' },
      select: {
        id: true,
        organizationId: true,
        clinicId: true,
        eventType: true,
        payload: true,
        attempts: true,
      },
    });
  });
}

export async function processOutboxBatch(workerId: string): Promise<number> {
  const events = await claimBatch(workerId);
  await Promise.all(events.map(async event => {
    try {
      await processEvent(event);
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          status: 'processed',
          processedAt: new Date(),
          lockedAt: null,
          lockedBy: null,
          lastError: null,
        },
      });
    } catch (error) {
      const terminal = event.attempts >= MAX_ATTEMPTS;
      const backoffSeconds = Math.min(3600, 2 ** Math.min(event.attempts, 10));
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          status: terminal ? 'dead_letter' : 'failed',
          availableAt: new Date(Date.now() + backoffSeconds * 1000),
          lockedAt: null,
          lockedBy: null,
          lastError: (error instanceof Error ? error.message : 'Unknown projection error').slice(0, 1000),
        },
      });
    }
  }));
  return events.length;
}

export function startOutboxWorker() {
  const workerId = `${process.pid}:${crypto.randomUUID()}`;
  let stopped = false;
  let activePoll: Promise<void> | null = null;
  const poll = async () => {
    try {
      let processed: number;
      do {
        processed = await processOutboxBatch(workerId);
      } while (processed === BATCH_SIZE);
    } catch (error) {
      console.error('Outbox worker poll failed', {
        message: error instanceof Error ? error.message : 'unknown error',
      });
    }
  };
  const trigger = () => {
    if (stopped || activePoll) return;
    activePoll = poll().finally(() => {
      activePoll = null;
    });
  };
  trigger();
  const timer = setInterval(trigger, 5_000);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await activePoll;
  };
}
