import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { toE164 } from '../lib/phone';
import {
  addMinutesToClinicString,
  parseInTimezone,
  toClinicTimeString,
} from '../lib/timezone';
import { getAvailableSlots } from './googleCalendar';
import { resolveDoctorForClinic } from './doctors';
import { normalizeTime } from '../tools/helpers';
import {
  assertCommercialFeatureAccess,
  assertCommercialFeatureAccessTx,
  COMMERCIAL_FEATURES,
  CommercialAccessError,
} from '../billing/access';

export class AppointmentCommandError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'invalid_input'
      | 'organization_inactive'
      | 'commercial_access'
      | 'not_found'
      | 'not_active'
      | 'slot_unavailable'
      | 'concurrent_change'
  ) {
    super(message);
  }
}

interface Slot {
  date: string;
  time: string;
  startAt: Date;
  endAt: Date;
  startAtString: string;
  endAtString: string;
}

function parseSlot(date: string, rawTime: string, timezone: string): Slot {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const time = normalizeTime(rawTime);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
  if (!dateMatch || !timeMatch) {
    throw new AppointmentCommandError('Date or time is invalid', 'invalid_input');
  }

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() + 1 !== month ||
    calendarDate.getUTCDate() !== day ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    throw new AppointmentCommandError('Date or time is invalid', 'invalid_input');
  }

  let startAtString: string;
  let endAtString: string;
  try {
    startAtString = toClinicTimeString(year, month, day, hour, minute, timezone);
    endAtString = addMinutesToClinicString(startAtString, 30, timezone);
  } catch {
    throw new AppointmentCommandError('The selected local time does not exist', 'invalid_input');
  }
  const startAt = new Date(startAtString);
  const endAt = new Date(endAtString);
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
    throw new AppointmentCommandError('Date or time is invalid', 'invalid_input');
  }

  // Catch nonexistent wall-clock times around daylight-saving transitions.
  const roundTrip = parseInTimezone(startAt.toISOString(), timezone);
  if (
    roundTrip.year !== year ||
    roundTrip.month !== month ||
    roundTrip.day !== day ||
    roundTrip.hour !== hour ||
    roundTrip.minute !== minute
  ) {
    throw new AppointmentCommandError('The selected local time does not exist', 'invalid_input');
  }
  if (startAt.getTime() <= Date.now()) {
    throw new AppointmentCommandError('Appointment time must be in the future', 'invalid_input');
  }

  return { date, time, startAt, endAt, startAtString, endAtString };
}

function isRetryableTransactionError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
}

function isSlotConstraintError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2002') return true;
  const detail = JSON.stringify(error.meta ?? {});
  return error.code === 'P2004' && detail.includes('Appointment_doctor_active_time_excl');
}

async function assertProviderSlot(clinicId: string, doctorId: string, slot: Slot) {
  const available = await getAvailableSlots(clinicId, slot.date, doctorId);
  if (!available.some(candidate => candidate.start === slot.time)) {
    throw new AppointmentCommandError('The selected slot is no longer available', 'slot_unavailable');
  }
}

async function loadOperationalClinic(organizationId: string, clinicId: string) {
  const clinic = await prisma.clinic.findFirst({
    where: { id: clinicId, organizationId },
  });
  if (!clinic) throw new AppointmentCommandError('Clinic not found', 'not_found');
  await assertAppointmentAccess(organizationId, clinicId);
  return clinic;
}

async function assertAppointmentAccess(organizationId: string, clinicId: string) {
  try {
    await assertCommercialFeatureAccess({
      organizationId,
      clinicId,
      feature: COMMERCIAL_FEATURES.APPOINTMENTS,
    });
  } catch (error) {
    if (error instanceof CommercialAccessError) {
      throw new AppointmentCommandError(error.message, 'commercial_access');
    }
    throw error;
  }
}

async function assertAppointmentAccessTx(
  tx: Prisma.TransactionClient,
  organizationId: string,
  clinicId: string
) {
  try {
    await assertCommercialFeatureAccessTx(tx, {
      organizationId,
      clinicId,
      feature: COMMERCIAL_FEATURES.APPOINTMENTS,
    });
  } catch (error) {
    if (error instanceof CommercialAccessError) {
      throw new AppointmentCommandError(error.message, 'commercial_access');
    }
    throw error;
  }
}

export interface CreateAppointmentCommand {
  organizationId: string;
  clinicId: string;
  patientName: string;
  patientPhone: string;
  date: string;
  time: string;
  reason: string;
  doctorId?: string | null;
  idempotencyKey: string;
  source: 'dashboard' | 'voice';
}

export async function createAppointmentCommand(input: CreateAppointmentCommand) {
  const operationKey = [
    input.source,
    'appointment',
    'create',
    input.organizationId,
    input.clinicId,
    input.idempotencyKey,
  ].join(':');
  const existing = await prisma.appointment.findUnique({ where: { idempotencyKey: operationKey } });
  if (existing) {
    if (existing.organizationId !== input.organizationId || existing.clinicId !== input.clinicId) {
      throw new AppointmentCommandError('Idempotency key collision', 'concurrent_change');
    }
    return { appointment: existing, duplicate: true };
  }

  const clinic = await loadOperationalClinic(input.organizationId, input.clinicId);
  const doctor = await resolveDoctorForClinic(
    input.organizationId,
    input.clinicId,
    input.doctorId
  );
  const slot = parseSlot(input.date, input.time, clinic.timezone);
  const patientPhone = toE164(input.patientPhone, clinic.defaultCallingCode);
  await assertProviderSlot(input.clinicId, doctor.id, slot);

  const execute = async () => prisma.$transaction(async tx => {
    const alreadyCreated = await tx.appointment.findUnique({
      where: { idempotencyKey: operationKey },
    });
    if (alreadyCreated) {
      if (
        alreadyCreated.organizationId !== input.organizationId ||
        alreadyCreated.clinicId !== input.clinicId
      ) {
        throw new AppointmentCommandError('Idempotency key collision', 'concurrent_change');
      }
      return { appointment: alreadyCreated, duplicate: true };
    }

    await assertAppointmentAccessTx(tx, input.organizationId, input.clinicId);

    const patient = await tx.patient.upsert({
      where: {
        organizationId_phone: {
          organizationId: input.organizationId,
          phone: patientPhone,
        },
      },
      create: {
        organizationId: input.organizationId,
        clinicId: input.clinicId,
        name: input.patientName,
        phone: patientPhone,
      },
      update: { name: input.patientName },
    });

    const conflict = await tx.appointment.findFirst({
      where: {
        organizationId: input.organizationId,
        clinicId: input.clinicId,
        doctorId: doctor.id,
        status: { in: ['scheduled', 'confirmed'] },
        startAt: { lt: slot.endAt },
        endAt: { gt: slot.startAt },
      },
      select: { id: true },
    });
    if (conflict) {
      throw new AppointmentCommandError('The selected slot is no longer available', 'slot_unavailable');
    }

    const appointment = await tx.appointment.create({
      data: {
        organizationId: input.organizationId,
        clinicId: input.clinicId,
        doctorId: doctor.id,
        patientId: patient.id,
        reason: input.reason,
        startAt: slot.startAt,
        endAt: slot.endAt,
        status: 'scheduled',
        calendarSyncStatus: 'pending',
        idempotencyKey: operationKey,
      },
    });
    await tx.outboxEvent.create({
      data: {
        organizationId: input.organizationId,
        clinicId: input.clinicId,
        aggregateType: 'Appointment',
        aggregateId: appointment.id,
        eventType: 'appointment.created',
        idempotencyKey: `appointment:${appointment.id}:created:v1`,
        payload: { appointmentId: appointment.id },
      },
    });
    return { appointment, duplicate: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  try {
    return await execute();
  } catch (error) {
    if (isRetryableTransactionError(error)) {
      try {
        return await execute();
      } catch (retryError) {
        if (isSlotConstraintError(retryError)) {
          throw new AppointmentCommandError('The selected slot is no longer available', 'slot_unavailable');
        }
        throw retryError;
      }
    }
    if (isSlotConstraintError(error)) {
      const duplicate = await prisma.appointment.findUnique({ where: { idempotencyKey: operationKey } });
      if (duplicate) {
        if (
          duplicate.organizationId !== input.organizationId ||
          duplicate.clinicId !== input.clinicId
        ) {
          throw new AppointmentCommandError('Idempotency key collision', 'concurrent_change');
        }
        return { appointment: duplicate, duplicate: true };
      }
      throw new AppointmentCommandError('The selected slot is no longer available', 'slot_unavailable');
    }
    throw error;
  }
}

export interface RescheduleAppointmentCommand {
  organizationId: string;
  clinicId: string;
  appointmentId: string;
  newDate: string;
  newTime: string;
  doctorId?: string | null;
  idempotencyKey: string;
  source: 'dashboard' | 'voice';
}

export async function rescheduleAppointmentCommand(input: RescheduleAppointmentCommand) {
  const operationKey = [
    input.source,
    'appointment',
    'reschedule',
    input.organizationId,
    input.clinicId,
    input.appointmentId,
    input.idempotencyKey,
  ].join(':');
  const prior = await prisma.appointment.findUnique({ where: { idempotencyKey: operationKey } });
  if (prior) {
    if (
      prior.organizationId !== input.organizationId ||
      prior.clinicId !== input.clinicId ||
      prior.supersedesAppointmentId !== input.appointmentId
    ) {
      throw new AppointmentCommandError('Idempotency key collision', 'concurrent_change');
    }
    return { appointment: prior, duplicate: true, previousAppointmentId: input.appointmentId };
  }

  const oldAppointment = await prisma.appointment.findFirst({
    where: {
      id: input.appointmentId,
      organizationId: input.organizationId,
      clinicId: input.clinicId,
    },
    include: { clinic: true },
  });
  if (!oldAppointment) throw new AppointmentCommandError('Appointment not found', 'not_found');
  if (!['scheduled', 'confirmed'].includes(oldAppointment.status)) {
    throw new AppointmentCommandError('Appointment is not active', 'not_active');
  }
  await assertAppointmentAccess(input.organizationId, input.clinicId);

  const doctor = await resolveDoctorForClinic(
    input.organizationId,
    input.clinicId,
    input.doctorId ?? oldAppointment.doctorId
  );
  const slot = parseSlot(input.newDate, input.newTime, oldAppointment.clinic.timezone);
  if (
    doctor.id === oldAppointment.doctorId &&
    slot.startAt.getTime() === oldAppointment.startAt.getTime() &&
    slot.endAt.getTime() === oldAppointment.endAt.getTime()
  ) {
    return { appointment: oldAppointment, duplicate: true, previousAppointmentId: oldAppointment.id };
  }
  await assertProviderSlot(input.clinicId, doctor.id, slot);

  try {
    return await prisma.$transaction(async tx => {
      const existing = await tx.appointment.findUnique({ where: { idempotencyKey: operationKey } });
      if (existing) {
        if (
          existing.organizationId !== input.organizationId ||
          existing.clinicId !== input.clinicId ||
          existing.supersedesAppointmentId !== input.appointmentId
        ) {
          throw new AppointmentCommandError('Idempotency key collision', 'concurrent_change');
        }
        return { appointment: existing, duplicate: true, previousAppointmentId: input.appointmentId };
      }

      await assertAppointmentAccessTx(tx, input.organizationId, input.clinicId);

      const cancelled = await tx.appointment.updateMany({
        where: {
          id: oldAppointment.id,
          organizationId: input.organizationId,
          clinicId: input.clinicId,
          version: oldAppointment.version,
          status: { in: ['scheduled', 'confirmed'] },
        },
        data: {
          status: 'cancelled',
          version: { increment: 1 },
          calendarSyncStatus: oldAppointment.googleEventId ? 'pending' : 'synced',
        },
      });
      if (cancelled.count !== 1) {
        throw new AppointmentCommandError('Appointment changed concurrently', 'concurrent_change');
      }

      const conflict = await tx.appointment.findFirst({
        where: {
          organizationId: input.organizationId,
          clinicId: input.clinicId,
          doctorId: doctor.id,
          status: { in: ['scheduled', 'confirmed'] },
          startAt: { lt: slot.endAt },
          endAt: { gt: slot.startAt },
        },
        select: { id: true },
      });
      if (conflict) {
        throw new AppointmentCommandError('The selected slot is no longer available', 'slot_unavailable');
      }

      const appointment = await tx.appointment.create({
        data: {
          organizationId: input.organizationId,
          clinicId: input.clinicId,
          doctorId: doctor.id,
          patientId: oldAppointment.patientId,
          reason: oldAppointment.reason,
          startAt: slot.startAt,
          endAt: slot.endAt,
          status: 'scheduled',
          calendarSyncStatus: 'pending',
          idempotencyKey: operationKey,
          supersedesAppointmentId: oldAppointment.id,
        },
      });
      await tx.outboxEvent.create({
        data: {
          organizationId: input.organizationId,
          clinicId: input.clinicId,
          aggregateType: 'Appointment',
          aggregateId: appointment.id,
          eventType: 'appointment.rescheduled',
          idempotencyKey: `appointment:${appointment.id}:rescheduled:v1`,
          payload: {
            appointmentId: appointment.id,
            previousAppointmentId: oldAppointment.id,
          },
        },
      });
      return { appointment, duplicate: false, previousAppointmentId: oldAppointment.id };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (isSlotConstraintError(error)) {
      throw new AppointmentCommandError('The selected slot is no longer available', 'slot_unavailable');
    }
    throw error;
  }
}

export async function cancelAppointmentCommand(input: {
  organizationId: string;
  clinicId: string;
  appointmentId: string;
}) {
  return prisma.$transaction(async tx => {
    const appointment = await tx.appointment.findFirst({
      where: {
        id: input.appointmentId,
        organizationId: input.organizationId,
        clinicId: input.clinicId,
      },
    });
    if (!appointment) throw new AppointmentCommandError('Appointment not found', 'not_found');
    if (appointment.status === 'cancelled') return { appointment, duplicate: true };
    if (!['scheduled', 'confirmed'].includes(appointment.status)) {
      throw new AppointmentCommandError('Appointment is not active', 'not_active');
    }

    const changed = await tx.appointment.updateMany({
      where: {
        id: appointment.id,
        organizationId: input.organizationId,
        clinicId: input.clinicId,
        version: appointment.version,
        status: { in: ['scheduled', 'confirmed'] },
      },
      data: {
        status: 'cancelled',
        version: { increment: 1 },
        calendarSyncStatus: appointment.googleEventId ? 'pending' : 'synced',
      },
    });
    if (changed.count !== 1) {
      throw new AppointmentCommandError('Appointment changed concurrently', 'concurrent_change');
    }
    await tx.outboxEvent.upsert({
      where: {
        organizationId_idempotencyKey: {
          organizationId: input.organizationId,
          idempotencyKey: `appointment:${appointment.id}:cancelled:v1`,
        },
      },
      create: {
        organizationId: input.organizationId,
        clinicId: input.clinicId,
        aggregateType: 'Appointment',
        aggregateId: appointment.id,
        eventType: 'appointment.cancelled',
        idempotencyKey: `appointment:${appointment.id}:cancelled:v1`,
        payload: { appointmentId: appointment.id },
      },
      update: {},
    });
    return {
      appointment: { ...appointment, status: 'cancelled', version: appointment.version + 1 },
      duplicate: false,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
