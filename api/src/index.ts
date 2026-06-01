import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import vapiWebhook from './routes/vapi.webhook';
import authRoutes from './routes/auth';

dotenv.config();

// Start reminder worker
import './queues/reminderQueue';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/api', vapiWebhook);
app.use('/api', authRoutes);

const PORT = process.env.PORT ?? 3001;
app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`API running on port ${PORT}`);
});