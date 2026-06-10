import { Queue, Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';
import { prisma } from '../lib/prisma';
import { sendSMS } from '../services/twilio';
import { placeOutboundCall } from '../services/vapiOutbound';

const connection = new Redis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
});

export const reminderQueue = new Queue('reminders', { connection });

// ── IST hour helpers ──────────────────────────────────────────────────────────

function getISTHour(): number {
  const istMs = Date.now() + 5.5 * 60 * 60 * 1000;
  return new Date(istMs).getUTCHours();
}

function isWithinCallHours(): boolean {
  const hour = getISTHour();
  return hour >= 8 && hour < 21; // 8 AM to 9 PM IST only
}

// ── Format appointment time ───────────────────────────────────────────────────

function formatAppointmentTime(startAt: Date): {
  readableTime: string;
  readableDate: string;
} {
  const istMs = startAt.getTime() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(istMs);
  const h = ist.getUTCHours();
  const m = ist.getUTCMinutes();
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  const minuteStr = m === 0 ? '' : `:${m.toString().padStart(2, '0')}`;
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun',
    'Jul','Aug','Sep','Oct','Nov','Dec'];
  return {
    readableTime: `${hour12}${minuteStr} ${period}`,
    readableDate: `${monthNames[ist.getUTCMonth()]} ${ist.getUTCDate()}`,
  };
}

// ── Schedule reminders at booking time ───────────────────────────────────────

export async function scheduleReminders(
  appointmentId: string,
  patientPhone: string,
  patientName: string,
  clinicName: string,
  startAt: Date
): Promise<void> {
  const now = Date.now();
  const apptMs = startAt.getTime();

  const ms24h = now + 30000;  //apptMs - 24 * 60 * 60 * 1000
  const ms6h  = now + 60000;  //apptMs - 6  * 60 * 60 * 1000

  if (ms24h > now) {
    const job24 = await reminderQueue.add(
      '24h-sms',
      { appointmentId, patientPhone, patientName, clinicName, type: '24h' },
      {
        delay: ms24h - now,
        attempts: 3,
        backoff: { type: 'exponential', delay: 60000 },
        jobId: `24h-${appointmentId}`,
      }
    );
    await prisma.reminderJob.create({
      data: {
        appointmentId,
        type: '24h',
        channel: 'sms',
        bullJobId: job24.id ?? undefined,
        scheduledAt: new Date(ms24h),
        status: 'pending',
      },
    });
    console.log(`24h SMS scheduled ✓ fires at ${new Date(ms24h).toISOString()}`);
  } else {
    console.log('24h reminder window already passed — skipping');
  }

  if (ms6h > now) {
    const job6 = await reminderQueue.add(
      '6h-call',
      { appointmentId, patientPhone, patientName, clinicName, type: '6h' },
      {
        delay: ms6h - now,
        attempts: 3,
        backoff: { type: 'exponential', delay: 60000 },
        jobId: `6h-${appointmentId}`,
      }
    );
    await prisma.reminderJob.create({
      data: {
        appointmentId,
        type: '6h',
        channel: 'call',
        bullJobId: job6.id ?? undefined,
        scheduledAt: new Date(ms6h),
        status: 'pending',
      },
    });
    console.log(`6h reminder scheduled ✓ fires at ${new Date(ms6h).toISOString()}`);
  } else {
    console.log('6h reminder window already passed — skipping');
  }
}

// ── Cancel reminders ──────────────────────────────────────────────────────────

export async function cancelReminders(appointmentId: string): Promise<void> {
  try {
    const job24 = await reminderQueue.getJob(`24h-${appointmentId}`);
    if (job24) {
      await job24.remove();
      console.log(`24h reminder removed ✓`);
    }

    const job6 = await reminderQueue.getJob(`6h-${appointmentId}`);
    if (job6) {
      await job6.remove();
      console.log(`6h reminder removed ✓`);
    }

    await prisma.reminderJob.updateMany({
      where: { appointmentId, status: 'pending' },
      data: { status: 'cancelled' },
    });

    console.log(`All reminders cancelled ✓ for ${appointmentId}`);
  } catch (err: any) {
    console.warn('Cancel reminders error (non-fatal):', err?.message);
  }
}

// ── SMS fallback ──────────────────────────────────────────────────────────────

async function sendFallbackSMS(
  phone: string,
  firstName: string,
  clinicName: string,
  readableTime: string,
  appointmentId: string
): Promise<void> {
  const message =
    `Hi ${firstName}, reminder from ${clinicName}: ` +
    `your appointment is today at ${readableTime}. ` +
    `To reschedule please call us. ` +
    `Do not reply to this message.`;

  await sendSMS(phone, message);

  await prisma.reminderJob.updateMany({
    where: { appointmentId, type: '6h' },
    data: { status: 'sent', sentAt: new Date() },
  });

  console.log(`6h fallback SMS sent ✓ to ${phone}`);
}

// ── Worker ────────────────────────────────────────────────────────────────────

export const reminderWorker = new Worker(
  'reminders',
  async (job: Job) => {
    const { appointmentId, patientPhone, patientName, clinicName, type } = job.data;

    console.log(`=== REMINDER JOB START === type: ${type} appointment: ${appointmentId}`);

    // Verify appointment is still active
    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
    });

    if (!appointment) {
      console.log(`Appointment ${appointmentId} not found — skipping`);
      return;
    }

    if (appointment.status === 'cancelled') {
      console.log(`Appointment ${appointmentId} is cancelled — skipping`);
      return;
    }

    const { readableTime, readableDate } = formatAppointmentTime(appointment.startAt);
    const firstName = patientName.split(' ')[0];
    const phone = patientPhone.startsWith('+') ? patientPhone : `+91${patientPhone}`;

    // ── 24h SMS ───────────────────────────────────────────────────────────────
    if (type === '24h') {
      const message =
        `Hi ${firstName}, this is a reminder from ${clinicName}. ` +
        `You have an appointment tomorrow (${readableDate}) at ${readableTime}. ` +
        `To reschedule please call us. ` +
        `Do not reply to this message.`;

      await sendSMS(phone, message);

      await prisma.reminderJob.updateMany({
        where: { appointmentId, type: '24h' },
        data: { status: 'sent', sentAt: new Date() },
      });

      console.log(`24h SMS sent ✓ to ${phone}`);
    }

    // ── 6h call or SMS ────────────────────────────────────────────────────────
    if (type === '6h') {
      const istHour = getISTHour();
      const canCall = isWithinCallHours();

      console.log(`IST hour: ${istHour} — canCall: ${canCall}`);

      if (canCall) {
        try {
          console.log('Placing outbound reminder call...');

          await placeOutboundCall(
            phone,
            process.env.VAPI_REMINDER_ASSISTANT_ID!,
            {
              patientName: firstName,
              clinicName,
              appointmentTime: readableTime,
              appointmentDate: readableDate,
            }
          );

          await prisma.reminderJob.updateMany({
            where: { appointmentId, type: '6h' },
            data: { status: 'sent', sentAt: new Date() },
          });

          console.log(`6h outbound call placed ✓ to ${phone}`);

        } catch (err: any) {
          console.error('Outbound call failed — falling back to SMS:', err?.message);
          await sendFallbackSMS(phone, firstName, clinicName, readableTime, appointmentId);
        }

      } else {
        console.log(`Outside call hours (IST ${istHour}:00) — sending SMS instead`);
        await sendFallbackSMS(phone, firstName, clinicName, readableTime, appointmentId);
      }
    }

    console.log(`=== REMINDER JOB DONE === type: ${type}`);
  },
  {
    connection: new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null }),
    concurrency: 5,
  }
);

reminderWorker.on('completed', (job) => {
  console.log(`Reminder job completed ✓ ${job.id}`);
});

reminderWorker.on('failed', (job, err) => {
  console.error(`Reminder job failed: ${job?.id}`, err?.message);
});