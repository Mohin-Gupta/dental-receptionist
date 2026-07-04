import { Router } from 'express';
import { getAuthUrl, handleOAuthCallback } from '../services/googleCalendar';
import { buildClinicContext } from '../services/clinicInfo';
import { requireAuth, requireClinic, requireMachineAuth, requirePermission } from '../auth/middleware';
import { auditAction } from '../auth/audit';
import { prisma } from '../lib/prisma';

const router = Router();

async function resolveDefaultClinicId(): Promise<string> {
  if (process.env.DEFAULT_CLINIC_ID) {
    return process.env.DEFAULT_CLINIC_ID;
  }

  const clinic = await prisma.clinic.findFirst({
    where: process.env.DEFAULT_ORGANIZATION_ID
      ? {
          organizationId:
            process.env.DEFAULT_ORGANIZATION_ID,
        }
      : undefined,
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });

  if (!clinic) {
    throw new Error('No default clinic is configured');
  }

  return clinic.id;
}

// Clinic admin visits this URL to connect their Google Calendar
router.get('/auth/google', requireAuth, requireClinic, requirePermission('integrations:manage'), (req, res) => {
  const clinicId = req.auth!.clinicId;
  const url = getAuthUrl(clinicId);
  res.redirect(url);
});

router.get('/clinic/context', requireMachineAuth, async (req, res) => {
  try {
    const clinicId = await resolveDefaultClinicId();
    const context = await buildClinicContext(clinicId);
    res.json({ context });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Google redirects here after admin approves
router.get('/auth/google/callback', requireAuth, requireClinic, requirePermission('integrations:manage'), async (req, res) => {
  const code = req.query.code as string;
  const clinicId = req.query.state as string;

  try {
    if (!clinicId || clinicId !== req.auth!.clinicId) {
      res.status(403).send('Invalid clinic access');
      return;
    }
    await handleOAuthCallback(code, clinicId);
    await auditAction(req, 'integration.google_calendar_connected', {
      organizationId: req.auth!.organizationId,
      clinicId,
      targetType: 'Clinic',
      targetId: clinicId,
    });
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
