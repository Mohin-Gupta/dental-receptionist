import { createRouter } from '../lib/asyncRouter';
import { z } from 'zod';
import { getAuthUrl, handleOAuthCallback } from '../services/googleCalendar';
import { buildClinicContext } from '../services/clinicInfo';
import {
  requireAuth,
  requireClinic,
  requireCsrf,
  requireMachineAuth,
  requireMfaForSensitiveAction,
  requirePermission,
} from '../auth/middleware';
import { auditAction } from '../auth/audit';
import { prisma } from '../lib/prisma';
import { consumeGoogleOAuthState, createGoogleOAuthState } from '../auth/oauthState';
import {
  assertCommercialFeatureAccess,
  COMMERCIAL_FEATURES,
  CommercialAccessError,
} from '../billing/access';
import { getWebOrigin } from '../auth/config';

const router = createRouter();

const clinicContextSchema = z.object({
  phoneNumberId: z.string().trim().min(1).max(200),
}).strict();

const googleStartSchema = z.object({
  scope: z.enum(['clinic', 'doctor']).default('clinic'),
  doctorId: z.string().uuid().optional(),
}).strict().superRefine((value, context) => {
  if (value.scope === 'doctor' && !value.doctorId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'doctorId is required for doctor scope' });
  }
  if (value.scope === 'clinic' && value.doctorId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'doctorId is only valid for doctor scope' });
  }
});

router.get('/auth/google', (_req, res) => {
  return res.status(410).json({ error: 'Use the authenticated Google Calendar start flow' });
});

router.get(
  '/auth/google/status',
  requireAuth,
  requireClinic,
  requirePermission('settings:read'),
  async (req, res) => {
    const organizationId = req.auth!.organizationId;
    const clinicId = req.auth!.clinicId;
    const [clinicConnection, doctors] = await Promise.all([
      prisma.calendarConnection.findFirst({
        where: { organizationId, clinicId, scope: 'clinic' },
        select: { id: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.doctor.findMany({
        where: { organizationId, clinics: { some: { clinicId } }, status: 'active' },
        select: {
          id: true,
          name: true,
          calendarConnections: {
            where: { organizationId, scope: 'doctor' },
            select: { id: true, updatedAt: true },
            take: 1,
          },
        },
        orderBy: { name: 'asc' },
      }),
    ]);
    return res.json({
      clinicId,
      clinicConnected: Boolean(clinicConnection),
      clinicConnectionUpdatedAt: clinicConnection?.updatedAt ?? null,
      doctors: doctors.map(doctor => ({
        id: doctor.id,
        name: doctor.name,
        directlyConnected: doctor.calendarConnections.length > 0,
        effectiveConnection: doctor.calendarConnections.length > 0
          ? 'doctor'
          : clinicConnection ? 'clinic_fallback' : 'none',
        updatedAt: doctor.calendarConnections[0]?.updatedAt ?? null,
      })),
    });
  }
);

router.post('/auth/google/start', requireAuth, requireClinic, requireCsrf, requirePermission('settings:write'), requireMfaForSensitiveAction, async (req, res) => {
  const parsed = googleStartSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid Google Calendar connection scope' });
  if (parsed.data.doctorId) {
    const doctor = await prisma.doctor.findFirst({
      where: {
        id: parsed.data.doctorId,
        organizationId: req.auth!.organizationId,
        clinics: { some: { clinicId: req.auth!.clinicId } },
      },
      select: { id: true },
    });
    if (!doctor) return res.status(404).json({ error: 'Doctor not found for this clinic' });
  }
  const state = await createGoogleOAuthState({
    organizationId: req.auth!.organizationId,
    clinicId: req.auth!.clinicId,
    doctorId: parsed.data.doctorId,
    userId: req.auth!.userId,
    sessionId: req.auth!.sessionId,
  });
  return res.json({ url: getAuthUrl(state) });
});

// Configure phoneNumberId as a Vapi static parameter sourced from
// `{{phoneNumber.id}}`. It is provider/signalling metadata, never an LLM tool
// argument. A global/default clinic fallback is intentionally forbidden.
router.post('/clinic/context', requireMachineAuth, async (req, res) => {
  try {
    const candidate = {
      phoneNumberId:
        req.body?.message?.phoneNumber?.id ??
        req.body?.phoneNumberId,
    };
    const parsed = clinicContextSchema.safeParse(candidate);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Trusted Vapi phoneNumberId is required' });
    }
    const resource = await prisma.providerResource.findUnique({
      where: {
        provider_resourceType_externalId: {
          provider: 'vapi',
          resourceType: 'phone_number',
          externalId: parsed.data.phoneNumberId,
        },
      },
      include: { providerAccount: { select: { status: true } } },
    });
    if (
      !resource?.clinicId ||
      resource.status !== 'active' ||
      resource.providerAccount.status !== 'active'
    ) {
      return res.status(404).json({ error: 'No active clinic mapping was found' });
    }
    await assertCommercialFeatureAccess({
      organizationId: resource.organizationId,
      clinicId: resource.clinicId,
      feature: COMMERCIAL_FEATURES.VOICE,
    });
    await assertCommercialFeatureAccess({
      organizationId: resource.organizationId,
      clinicId: resource.clinicId,
      feature: COMMERCIAL_FEATURES.APPOINTMENTS,
    });
    const context = await buildClinicContext(resource.clinicId);
    res.json({ context });
  } catch (err: unknown) {
    if (err instanceof CommercialAccessError) {
      return res.status(err.statusCode).json({ error: 'Clinic service is unavailable' });
    }
    res.status(500).json({ error: 'Clinic context could not be loaded' });
  }
});

// Google redirects here after admin approves
router.get('/auth/google/callback', requireAuth, requireMfaForSensitiveAction, async (req, res) => {
  const code = req.query.code as string;
  const state = typeof req.query.state === 'string' ? req.query.state : '';

  try {
    if (!code || !state) {
      res.status(400).send('Missing OAuth callback details');
      return;
    }
    const oauthState = await consumeGoogleOAuthState(state, {
      userId: req.auth!.userId,
      sessionId: req.auth!.sessionId,
    });
    const hasClinicAccess = req.auth!.clinics.some(
      (clinic) =>
        clinic.id === oauthState.clinicId &&
        clinic.organizationId === oauthState.organizationId
    );
    if (!hasClinicAccess) {
      res.status(403).send('Invalid clinic access');
      return;
    }
    const clinicId = oauthState.clinicId;
    await handleOAuthCallback(code, clinicId, oauthState.doctorId);
    await auditAction(req, 'integration.google_calendar_connected', {
      organizationId: oauthState.organizationId,
      clinicId,
      targetType: 'Clinic',
      targetId: clinicId,
    });
    const webOrigin = getWebOrigin().split(',')[0]?.trim();
    if (!webOrigin) throw new Error('Web origin is not configured');
    return res.redirect(new URL('/dashboard/integrations?calendar=connected', webOrigin).toString());
  } catch (err) {
    console.error('Google OAuth connection failed', {
      type: err instanceof Error ? err.name : 'unknown',
      ...(process.env.NODE_ENV === 'production' || !(err instanceof Error)
        ? {}
        : { message: err.message }),
    });
    res.status(500).send('Connection failed');
  }
});

export default router;
