import { Queue, Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';
import { prisma } from '../lib/prisma';
import { sendSMS } from '../services/twilio';
import { placeOutboundCall } from '../services/vapiOutbound';
import { formatInTimezone, isWithinHours, getClinicTimezone, getTodayRangeInTimezone } from '../lib/timezone';

const connection = new Redis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
});

export const reminderQueue = new Queue('reminders', { connection });

// ── Schedule reminders after booking ─────────────────────────────────────────

export async function scheduleReminders(
  appointmentId: string,
  patientPhone: string,
  patientName: string,
  clinicName: string,
  startAt: Date
): Promise<void> {
  const now = Date.now();
  const ms60min   = startAt.getTime() - 60 * 60 * 1000;
  const msFeedback = startAt.getTime() + 60 * 60 * 1000;

  if (ms60min > now) {
    const job = await reminderQueue.add(
      '60min-reminder',
      { appointmentId, patientPhone, patientName, clinicName, type: '60min' },
      {
        delay: ms60min - now,
        attempts: 3,
        backoff: { type: 'exponential', delay: 60000 },
        jobId: `60min-${appointmentId}`,
      }
    );

    await prisma.reminderJob.create({
      data: {
        appointmentId,
        type: '60min',
        channel: 'call',
        bullJobId: job.id ?? undefined,
        scheduledAt: new Date(ms60min),
        status: 'pending',
      },
    });

    console.log(`60-min reminder scheduled ✓ fires at ${new Date(ms60min).toISOString()}`);
  } else {
    console.log(`Appointment is within 60 minutes — skipping reminder job`);
  }

  if (msFeedback > now) {
    const feedbackJob = await reminderQueue.add(
      'feedback-sms',
      { appointmentId, patientPhone, patientName, clinicName, type: 'feedback' },
      {
        delay: msFeedback - now,
        attempts: 2,
        backoff: { type: 'exponential', delay: 60000 },
        jobId: `feedback-${appointmentId}`,
      }
    );

    await prisma.reminderJob.create({
      data: {
        appointmentId,
        type: 'feedback',
        channel: 'sms',
        bullJobId: feedbackJob.id ?? undefined,
        scheduledAt: new Date(msFeedback),
        status: 'pending',
      },
    });

    console.log(`Feedback SMS scheduled ✓ fires at ${new Date(msFeedback).toISOString()}`);
  }
}

// ── Cancel reminders (on cancel or reschedule) ────────────────────────────────

export async function cancelReminders(appointmentId: string): Promise<void> {
  try {
    const job60 = await reminderQueue.getJob(`60min-${appointmentId}`);
    if (job60) await job60.remove();

    const jobFeedback = await reminderQueue.getJob(`feedback-${appointmentId}`);
    if (jobFeedback) await jobFeedback.remove();

    await prisma.reminderJob.updateMany({
      where: { appointmentId, status: 'pending' },
      data: { status: 'cancelled' },
    });

    console.log(`Reminders cancelled ✓ for ${appointmentId}`);
  } catch (err: any) {
    console.warn('Cancel reminders error:', err?.message);
  }
}

// ── Schedule daily agenda ─────────────────────────────────────────────────────

export async function scheduleDailyAgenda(): Promise<void> {
  const existing = await reminderQueue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === 'daily-agenda') {
      await reminderQueue.removeRepeatableByKey(job.key);
    }
  }
  await reminderQueue.add(
    'daily-agenda',
    { type: 'agenda', clinicId: process.env.DEFAULT_CLINIC_ID },
    {
      repeat: { pattern: '30 3 * * *' }, // 9:00 AM IST = 3:30 AM UTC
      jobId: 'daily-agenda',
    }
  );
  console.log('Daily agenda job registered ✓ fires at 9:00 AM IST');
}

// ── Mark past appointments as completed ───────────────────────────────────────

export async function scheduleAppointmentStatusUpdater(): Promise<void> {
  const existing = await reminderQueue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === 'update-appointment-status') {
      await reminderQueue.removeRepeatableByKey(job.key);
    }
  }
  await reminderQueue.add(
    'update-appointment-status',
    { type: 'status-update' },
    {
      repeat: { every: 60 * 60 * 1000 },
      jobId: 'update-appointment-status',
    }
  );
  console.log('Appointment status updater scheduled ✓ runs every hour');
}

// ── Worker ────────────────────────────────────────────────────────────────────

export const reminderWorker = new Worker(
  'reminders',
  async (job: Job) => {
    const { appointmentId, patientPhone, patientName, clinicName, type } = job.data;

    console.log(`=== REMINDER JOB === type: ${type}`);

    // ── Hourly status updater ─────────────────────────────────────────────────
    if (type === 'status-update') {
      const updated = await prisma.appointment.updateMany({
        where: {
          status: { in: ['scheduled', 'confirmed'] },
          endAt: { lt: new Date() },
        },
        data: { status: 'completed' },
      });
      if (updated.count > 0) {
        console.log(`Marked ${updated.count} appointments as completed ✓`);
      }
      return;
    }

    // ── Daily agenda SMS to doctor ────────────────────────────────────────────
    if (type === 'agenda') {
      const { clinicId } = job.data;

      const clinic = await prisma.clinic.findUnique({ where: { id: clinicId } });
      if (!clinic?.doctorPhone) {
        console.log('No doctor phone — skipping agenda');
        return;
      }

      const timezone = clinic.timezone ?? 'Asia/Kolkata';
      const { todayStart, todayEnd } = getTodayRangeInTimezone(timezone);

      const appointments = await prisma.appointment.findMany({
        where: {
          clinicId,
          status: { in: ['scheduled', 'confirmed'] },
          startAt: { gte: todayStart, lt: todayEnd },
        },
        include: { patient: true },
        orderBy: { startAt: 'asc' },
      });

      const doctorPhone = clinic.doctorPhone.startsWith('+')
        ? clinic.doctorPhone
        : `+91${clinic.doctorPhone}`;

      if (appointments.length === 0) {
        await sendSMS(doctorPhone,
          `Good morning Doctor. No appointments scheduled for today at ${clinic.name}. ` +
          `Have a great day! Do not reply to this message.`
        );
        console.log('No appointments today — agenda SMS sent to doctor ✓');
        return;
      }

      const agendaList = appointments.map((a, i) => {
        const { readableTime } = formatInTimezone(a.startAt, timezone);
        return `${i + 1}. ${a.patient.name} at ${readableTime} — ${a.reason}`;
      }).join('. ');

      await sendSMS(doctorPhone,
        `Good morning Doctor. Today's schedule at ${clinic.name}: ${agendaList}. ` +
        `Total: ${appointments.length} appointment${appointments.length > 1 ? 's' : ''}. ` +
        `Do not reply to this message.`
      );
      console.log(`Daily agenda SMS sent to doctor ✓ — ${appointments.length} appointments`);
      return;
    }

    // ── Load appointment + clinic timezone for reminder jobs ──────────────────
    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: { clinic: true },
    });

    if (!appointment || appointment.status === 'cancelled') {
      console.log(`Appointment ${appointmentId} not active — skipping`);
      return;
    }

    const timezone = appointment.clinic.timezone ?? 'Asia/Kolkata';
    const { readableTime, readableDate } = formatInTimezone(appointment.startAt, timezone);
    const firstName = patientName.split(' ')[0];
    const phone = patientPhone.startsWith('+') ? patientPhone : `+91${patientPhone}`;

    // ── 60-min pre-appointment reminder ──────────────────────────────────────
    if (type === '60min') {
      const canCall = isWithinHours(timezone, 8, 21);
      console.log(`canCall (8am–9pm in ${timezone}): ${canCall}`);

      if (canCall) {
        try {
          await placeOutboundCall(
            phone,
            process.env.VAPI_REMINDER_ASSISTANT_ID!,
            { patientName: firstName, clinicName, appointmentTime: readableTime, appointmentDate: readableDate }
          );
          console.log('60-min reminder call placed ✓');
        } catch (err: any) {
          console.error('60-min reminder call failed — SMS fallback:', err?.message);
          await sendSMS(phone,
            `Hi ${firstName}, reminder from ${clinicName}: your appointment is in 1 hour at ${readableTime}. ` +
            `Please call us if you need to reschedule. Do not reply to this message.`
          );
        }
      } else {
        console.log(`Outside call hours in ${timezone} — sending SMS reminder`);
        await sendSMS(phone,
          `Hi ${firstName}, reminder from ${clinicName}: your appointment is in 1 hour at ${readableTime}. ` +
          `Please call us if you need to reschedule. Do not reply to this message.`
        );
      }

      await prisma.reminderJob.updateMany({
        where: { appointmentId, type: '60min' },
        data: { status: 'sent', sentAt: new Date() },
      });

      console.log(`60-min reminder done ✓`);
      return;
    }

    // ── Feedback SMS 60 min after appointment ─────────────────────────────────
    if (type === 'feedback') {
      try {
        await sendSMS(phone,
          `Hi ${firstName}, we hope your visit to ${clinicName} went well! ` +
          `Your satisfaction means a lot to us — feel free to call us anytime. ` +
          `Do not reply to this message.`
        );
        console.log(`Feedback SMS sent ✓ to ${phone}`);
      } catch (err: any) {
        console.error('Feedback SMS failed (non-fatal):', err?.message);
      }

      await prisma.reminderJob.updateMany({
        where: { appointmentId, type: 'feedback' },
        data: { status: 'sent', sentAt: new Date() },
      });

      console.log(`Feedback job done ✓`);
      return;
    }

    console.log(`=== REMINDER JOB DONE === type: ${type}`);
  },
  {
    connection: new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null }),
    concurrency: 5,
  }
);

reminderWorker.on('completed', (job) => console.log(`Job done ✓ ${job.id}`));
reminderWorker.on('failed', (job, err) => console.error(`Job failed: ${job?.id}`, err?.message));