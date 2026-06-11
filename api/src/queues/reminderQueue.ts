import { Queue, Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';
import { prisma } from '../lib/prisma';
import { sendSMS } from '../services/twilio';
import { placeOutboundCall } from '../services/vapiOutbound';

const connection = new Redis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
});

export const reminderQueue = new Queue('reminders', { connection });

// ── Helpers ───────────────────────────────────────────────────────────────────

function getISTHour(): number {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).getUTCHours();
}

function isWithinCallHours(): boolean {
  const hour = getISTHour();
  return hour >= 8 && hour < 21;
}

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

async function sendPatientReminder(
  phone: string,
  firstName: string,
  clinicName: string,
  readableTime: string,
  readableDate: string,
  appointmentId: string
): Promise<void> {
  try {
    await placeOutboundCall(
      phone,
      process.env.VAPI_REMINDER_ASSISTANT_ID!,
      { patientName: firstName, clinicName, appointmentTime: readableTime, appointmentDate: readableDate }
    );
    console.log('Patient reminder call placed ✓');
  } catch (err: any) {
    console.error('Patient reminder call failed — SMS fallback:', err?.message);
    await sendSMS(phone,
      `Hi ${firstName}, reminder from ${clinicName}: ` +
      `your appointment is today at ${readableTime}. ` +
      `To reschedule please call us. Do not reply to this message.`
    );
  }
  await prisma.reminderJob.updateMany({
    where: { appointmentId, type: '6h' },
    data: { status: 'sent', sentAt: new Date() },
  });
}

async function sendFallbackSMS(
  phone: string,
  firstName: string,
  clinicName: string,
  readableTime: string,
  appointmentId: string
): Promise<void> {
  await sendSMS(phone,
    `Hi ${firstName}, reminder from ${clinicName}: ` +
    `your appointment is today at ${readableTime}. ` +
    `To reschedule please call us. Do not reply to this message.`
  );
  await prisma.reminderJob.updateMany({
    where: { appointmentId, type: '6h' },
    data: { status: 'sent', sentAt: new Date() },
  });
  console.log(`Fallback SMS sent ✓ to ${phone}`);
}

// ── Schedule reminders ────────────────────────────────────────────────────────

export async function scheduleReminders(
  appointmentId: string,
  patientPhone: string,
  patientName: string,
  clinicName: string,
  startAt: Date
): Promise<void> {
  const now = Date.now();
  const apptMs = startAt.getTime();
  const ms24h = now + 30000;  //apptMs - 24 * 60 * 60 * 1000;
  const ms6h  = now + 60000;  //apptMs - 6  * 60 * 60 * 1000;

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
  }
}

// ── Cancel reminders ──────────────────────────────────────────────────────────

export async function cancelReminders(appointmentId: string): Promise<void> {
  try {
    const job24 = await reminderQueue.getJob(`24h-${appointmentId}`);
    if (job24) await job24.remove();
    const job6 = await reminderQueue.getJob(`6h-${appointmentId}`);
    if (job6) await job6.remove();
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
      repeat: { pattern : '30 3 * * *' }, // 9:00 AM IST = 3:30 AM UTC      repeat: { pattern : '30 3 * * *' },
      jobId: 'daily-agenda',
    }
  );
  console.log('Daily agenda job registered ✓ fires at 9:00 AM IST');
}

// ── Worker ────────────────────────────────────────────────────────────────────

export const reminderWorker = new Worker(
  'reminders',
  async (job: Job) => {
    const { appointmentId, patientPhone, patientName, clinicName, type } = job.data;

    console.log(`=== REMINDER JOB === type: ${type}`);

    // ── Daily agenda ──────────────────────────────────────────────────────────
    if (type === 'agenda') {
      const { clinicId } = job.data;

      const clinic = await prisma.clinic.findUnique({ where: { id: clinicId } });
      if (!clinic?.doctorPhone) {
        console.log('No doctor phone — skipping agenda');
        return;
      }

      const nowIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
      const todayStart = new Date(Date.UTC(
        nowIST.getUTCFullYear(), nowIST.getUTCMonth(), nowIST.getUTCDate(),
        3, 30, 0
      ));
      const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

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
          `Good morning Doctor. ` 
        );  //`Good morning Doctor. No appointments scheduled for today at ${clinic.name}. ` +
          //`Have a great day! Do not reply to this message.`
        console.log('No appointments today — agenda SMS sent to doctor ✓');
        return;
      }

      const agendaList = appointments.map((a, i) => {
        const { readableTime } = formatAppointmentTime(a.startAt);
        return `${i + 1}. ${a.patient.name} at ${readableTime} — ${a.reason}`;
      }).join('. ');

      await sendSMS(doctorPhone,
        `Good morning Doctor.`
      );  /*`Good morning Doctor. Today's schedule at ${clinic.name}: ${agendaList}. ` +
        `Total: ${appointments.length} appointment${appointments.length > 1 ? 's' : ''}. ` +
        `Do not reply to this message.`*/

      console.log(`Daily agenda SMS sent to doctor ✓ — ${appointments.length} appointments`);
      return;
    }

    // ── Appointment reminders — verify appointment still active ───────────────
    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
    });

    if (!appointment || appointment.status === 'cancelled') {
      console.log(`Appointment ${appointmentId} not active — skipping`);
      return;
    }

    const { readableTime, readableDate } = formatAppointmentTime(appointment.startAt);
    const firstName = patientName.split(' ')[0];
    const phone = patientPhone.startsWith('+') ? patientPhone : `+91${patientPhone}`;

    // ── 24h SMS ───────────────────────────────────────────────────────────────
    if (type === '24h') {
      await sendSMS(phone,
        `Hi ${firstName}, reminder from ${clinicName}: ` +
        `you have an appointment tomorrow (${readableDate}) at ${readableTime}. ` +
        `To reschedule please call us. Do not reply to this message.`
      );
      await prisma.reminderJob.updateMany({
        where: { appointmentId, type: '24h' },
        data: { status: 'sent', sentAt: new Date() },
      });
      console.log(`24h SMS sent ✓ to ${phone}`);
    }

    // ── 6h call with doctor confirmation ─────────────────────────────────────
    if (type === '6h') {
      const canCall = isWithinCallHours();
      console.log(`IST hour: ${getISTHour()} — canCall: ${canCall}`);

      if (!canCall) {
        console.log('Outside call hours — SMS to patient');
        await sendFallbackSMS(phone, firstName, clinicName, readableTime, appointmentId);
        return;
      }

      // Check if doctor phone is set
      const clinic = await prisma.clinic.findUnique({
        where: { id: appointment.clinicId },
      });

      const doctorPhone = clinic?.doctorPhone ?? process.env.DOCTOR_PHONE;

      if (!doctorPhone) {
        console.log('No doctor phone — sending patient reminder directly');
        await sendPatientReminder(phone, firstName, clinicName, readableTime, readableDate, appointmentId);
        return;
      }

      const formattedDoctorPhone = doctorPhone.startsWith('+')
        ? doctorPhone
        : `+91${doctorPhone}`;

      // Fetch full appointment details for doctor call
      const apptWithPatient = await prisma.appointment.findUnique({
        where: { id: appointmentId },
        include: { patient: true },
      });

      try {
        console.log('Calling doctor to confirm appointment...');

        await placeOutboundCall(
          formattedDoctorPhone,
          process.env.VAPI_DOCTOR_CONFIRM_ASSISTANT_ID!,
          {
            patientName: apptWithPatient?.patient.name ?? patientName,
            clinicName,
            appointmentTime: readableTime,
            appointmentDate: readableDate,
            appointmentReason: apptWithPatient?.reason ?? 'appointment',
            appointmentId,
          }
        );

        console.log('Doctor confirmation call placed ✓');
        // Patient reminder fires from confirmDoctorAppointment tool response
        await prisma.reminderJob.updateMany({
          where: { appointmentId, type: '6h' },
          data: { status: 'sent', sentAt: new Date() },
        });

      } catch (err: any) {
        // Doctor call failed — send patient reminder directly, change nothing
        console.error('Doctor call failed — sending patient reminder directly:', err?.message);
        await sendPatientReminder(phone, firstName, clinicName, readableTime, readableDate, appointmentId);
      }
    }

    // ── Feedback call 24h after appointment ───────────────────────────────────
    if (type === 'feedback') {
      const { reason } = job.data;

      if (appointment.status === 'cancelled') {
        console.log('Appointment cancelled — skipping feedback');
        return;
      }

      if (!isWithinCallHours()) {
        console.log('Outside call hours — skipping feedback call');
        return;
      }

      try {
        await placeOutboundCall(
          phone,
          process.env.VAPI_FEEDBACK_ASSISTANT_ID!,
          {
            patientName: firstName,
            clinicName,
            appointmentReason: reason ?? 'your visit',
          }
        );
        console.log(`Feedback call placed ✓ to ${phone}`);
      } catch (err: any) {
        console.error('Feedback call failed:', err?.message);
      }
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