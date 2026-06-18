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

app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/api', vapiWebhook);
app.use('/api', authRoutes);
app.use('/api', dashboardRoutes);

const PORT = process.env.PORT ?? 3001;
app.listen(Number(PORT), '0.0.0.0', async () => {
  console.log(`API running on port ${PORT}`);
  
  // Run immediately on start to classify existing appointments
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