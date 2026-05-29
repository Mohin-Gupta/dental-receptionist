import { Router } from 'express';
import { getAuthUrl, handleOAuthCallback } from '../services/googleCalendar';

const router = Router();

// Clinic admin visits this URL to connect their Google Calendar
router.get('/auth/google', (req, res) => {
  const clinicId = req.query.clinicId as string;
  if (!clinicId) {
    res.status(400).json({ error: 'clinicId required' });
    return;
  }
  const url = getAuthUrl(clinicId);
  res.redirect(url);
});

// Google redirects here after admin approves
router.get('/auth/google/callback', async (req, res) => {
  const code = req.query.code as string;
  const clinicId = req.query.state as string;

  try {
    await handleOAuthCallback(code, clinicId);
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h2>✓ Google Calendar connected!</h2>
        <p>Maya can now check availability and book appointments.</p>
      </body></html>
    `);
  } catch (err) {
    console.error('OAuth error:', err);
    res.status(500).send('Connection failed');
  }
});

export default router;