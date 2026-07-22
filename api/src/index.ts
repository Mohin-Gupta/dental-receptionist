import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { getWebOrigin } from './auth/config';
import { validateRuntimeConfiguration } from './config/runtime';
import { prisma } from './lib/prisma';
import { redis } from './lib/redis';
import { reminderQueue } from './queues/reminderQueue';
import billingRoutes from './routes/billing.routes';
import customAuthRoutes from './routes/customAuth';
import integrationAuthRoutes from './routes/auth';
import dashboardRoutes from './routes/dashboard';
import twilioWebhook from './routes/twilio.webhook';
import vapiWebhook from './routes/vapi.webhook';
import { providerWebhookRateLimit } from './auth/rateLimit';
import operationsRoutes from './routes/operations.routes';
import { assertFreshWorkerHeartbeat } from './ops/workerHeartbeat';

validateRuntimeConfiguration();

const app = express();

const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? '1');
if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 5) {
  throw new Error('TRUST_PROXY_HOPS must be an integer between 0 and 5');
}
app.set('trust proxy', trustProxyHops);
app.disable('x-powered-by');
app.use(helmet());
app.use((req, res, next) => {
  const supplied = req.header('x-request-id');
  const requestId = supplied && /^[A-Za-z0-9._:-]{1,100}$/.test(supplied)
    ? supplied
    : crypto.randomUUID();
  res.setHeader('x-request-id', requestId);
  res.locals.requestId = requestId;
  // API responses can contain patient, billing, or decrypted call data. Keep
  // them out of browser and intermediary caches by default.
  res.setHeader('cache-control', 'private, no-store, max-age=0');
  res.setHeader('pragma', 'no-cache');
  next();
});

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

// Reject abusive public-provider traffic before allocating buffers to parse
// its body. Both singular and plural paths are used by the provider routes.
app.use(['/api/webhook', '/api/webhooks'], providerWebhookRateLimit);

// Provider signatures must be checked against the exact bytes received. The
// parsed body remains available to normal handlers while rawBody is retained
// for Stripe and Vapi signature verification.
app.use(express.json({
  limit: Number(process.env.JSON_BODY_LIMIT_BYTES ?? 1_048_576),
  verify: (req, _res, buffer) => {
    (req as express.Request).rawBody = Buffer.from(buffer);
  },
}));
app.use(express.urlencoded({
  extended: true,
  limit: Number(process.env.URLENCODED_BODY_LIMIT_BYTES ?? 262_144),
}));
app.use(cookieParser());

app.get(['/health', '/health/live'], (_req, res) => {
  res.setHeader('cache-control', 'no-store');
  return res.json({ status: 'ok' });
});

app.get('/health/ready', async (_req, res) => {
  res.setHeader('cache-control', 'no-store');
  try {
    await Promise.race([
      Promise.all([
        prisma.$queryRaw`SELECT 1`,
        redis.ping(),
        assertFreshWorkerHeartbeat(),
      ]),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Readiness check timed out')), 2_000);
        timer.unref();
      }),
    ]);
    return res.json({ status: 'ready' });
  } catch {
    return res.status(503).json({ status: 'not_ready' });
  }
});

// Public provider webhooks perform their own cryptographic authentication.
// Keep them ahead of session-authenticated application routes.
app.use('/api', vapiWebhook);
app.use('/api', twilioWebhook);
app.use('/api', billingRoutes);
app.use('/api', operationsRoutes);
app.use('/api', customAuthRoutes);
app.use('/api', integrationAuthRoutes);
app.use('/api', dashboardRoutes);

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const candidate = err as { type?: string; name?: string; message?: string };
  console.error('Unhandled request error', {
    requestId: res.locals.requestId,
    type: candidate?.type ?? candidate?.name ?? 'unknown',
    ...(process.env.NODE_ENV === 'production' ? {} : { message: candidate?.message }),
  });
  if (candidate?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large' });
  }
  if (candidate?.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  return res.status(500).json({ error: 'Internal server error' });
});

const PORT = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT must be a valid TCP port');
}

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`API ready on port ${PORT}`);
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`API received ${signal}; shutting down`);

  const forceTimer = setTimeout(() => {
    console.error('API graceful shutdown timed out');
    process.exit(1);
  }, 10_000);
  forceTimer.unref();

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.allSettled([reminderQueue.close(), redis.quit(), prisma.$disconnect()]);
  clearTimeout(forceTimer);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

export { app };
