import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import helmet from 'helmet';
import vapiWebhook from './routes/vapi.webhook';
import customAuthRoutes from './routes/customAuth';
import integrationAuthRoutes from './routes/auth';
import dashboardRoutes from './routes/dashboard';
import { scheduleDailyAgenda, scheduleAppointmentStatusUpdater } from './queues/repeatableJobs';
import { prisma } from './lib/prisma';
import { getWebOrigin } from './auth/config';
import { cleanupConsumedAuthTokens } from './auth/tokenCleanup';
dotenv.config();

// Starts the worker that processes queued reminder jobs. Must be imported
// somewhere at startup or jobs will sit in Redis and never run — previously
// this same side-effect import pointed at reminderQueue.ts directly; now the
// worker lives in its own file since reminderQueue.ts no longer contains it.
import './queues/reminderWorker';

const app = express();

app.set('trust proxy', 1);
app.use(helmet());

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);

    const allowedOrigins = getWebOrigin()
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    const allowLocalDev =
      process.env.NODE_ENV !== 'production' &&
      (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:'));

    if (allowedOrigins.includes(origin) || allowLocalDev) {
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
app.use(cookieParser());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/api', customAuthRoutes);
app.use('/api', vapiWebhook);
app.use('/api', integrationAuthRoutes);
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
const tokenCleanupTimer = setInterval(() => {
  cleanupConsumedAuthTokens().catch((err: any) =>
    console.warn('Auth token cleanup failed:', err?.message)
  );
}, 15 * 60 * 1000);
tokenCleanupTimer.unref();

app.listen(Number(PORT), '0.0.0.0', async () => {
  console.log(`API running on port ${PORT}`);

  try {
    await cleanupConsumedAuthTokens();
  } catch (err: any) {
    console.warn('Initial auth token cleanup failed:', err?.message);
  }

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
