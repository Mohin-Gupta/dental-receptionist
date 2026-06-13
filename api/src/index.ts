import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import vapiWebhook from './routes/vapi.webhook';
import authRoutes from './routes/auth';
import { scheduleDailyAgenda } from './queues/reminderQueue';
import dashboardRoutes from './routes/dashboard';




dotenv.config();

// Start worker
import './queues/reminderQueue';

const app = express();
app.use(cors());
app.use(express.json());
app.use('/api', dashboardRoutes);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/api', vapiWebhook);
app.use('/api', authRoutes);

const PORT = process.env.PORT ?? 3001;
app.listen(Number(PORT), '0.0.0.0', async () => {
  console.log(`API running on port ${PORT}`);
  try {
    await scheduleDailyAgenda();
  } catch (err: any) {
    console.warn('Daily agenda scheduling failed:', err?.message);
  }
});