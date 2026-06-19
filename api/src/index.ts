import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import vapiWebhook from './routes/vapi.webhook';
import authRoutes from './routes/auth';
import dashboardRoutes from './routes/dashboard';
import { scheduleDailyAgenda, scheduleAppointmentStatusUpdater } from './queues/reminderQueue';
import { prisma } from './lib/prisma';
dotenv.config();

import './queues/reminderQueue';

const app = express();

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);

    if (
      origin.includes('localhost') ||
      origin.endsWith('.vercel.app')
    ) {
      return callback(null, true);
    }

    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

// Default express.json() limit is 100kb — Vapi's end-of-call-report payloads
// include the full call transcript plus metadata, which can easily exceed
// that on longer calls. Without raising this, Express silently rejects the
// webhook with a 413 PayloadTooLargeError BEFORE it ever reaches our route
// handler — meaning the call never gets logged, no error is visible in our
// own application logs, and it looks like the call simply vanished.
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/api', vapiWebhook);
app.use('/api', authRoutes);
app.use('/api', dashboardRoutes);

// Catch-all error handler — ensures any future payload/parsing errors are at
// least logged on our side instead of failing completely silently like this one did.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled request error:', err?.message, err?.type ?? '');
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large' });
  }
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT ?? 3001;
app.listen(Number(PORT), '0.0.0.0', async () => {
  console.log(`API running on port ${PORT}`);

  try {
    const updated = await prisma.appointment.updateMany({
      where: {
        status: { in: ['scheduled', 'confirmed'] },
        endAt: { lt: new Date() },
      },
      data: { status: 'completed' },
    });
    if (updated.count > 0) {
      console.log(`Marked ${updated.count} past appointments as completed ✓`);
    }
  } catch (err: any) {
    console.warn('Status update failed:', err?.message);
  }

  try {
    await scheduleDailyAgenda();
    await scheduleAppointmentStatusUpdater();
  } catch (err: any) {
    console.warn('Scheduling failed:', err?.message);
  }
});