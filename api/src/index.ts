import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import vapiWebhook from './routes/vapi.webhook';
import authRoutes from './routes/auth';
import dashboardRoutes from './routes/dashboard';
import { scheduleDailyAgenda } from './queues/reminderQueue';

dotenv.config();

import './queues/reminderQueue';

const app = express();

app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:3001',
    'https://dental-receptionist.vercel.app',
  ],
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
  try {
    await scheduleDailyAgenda();
  } catch (err: any) {
    console.warn('Daily agenda scheduling failed:', err?.message);
  }
});