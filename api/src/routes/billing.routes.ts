import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { auditAction } from '../auth/audit';
import {
  requireAuth,
  requireCsrf,
  requireMfaForSensitiveAction,
} from '../auth/middleware';
import { BillingConfigurationError, UnknownBillingPlanError } from '../billing/config';
import {
  serializeTenantBudget,
  saveTenantBudget,
  TenantBudgetInputError,
  tenantBudgetInputSchema,
} from '../billing/budgets';
import {
  BillingConflictError,
  createStripeCheckoutSession,
  createStripePortalSession,
} from '../billing/checkout';
import { getBillingSummary } from '../billing/summary';
import { StripeApiError } from '../billing/stripeClient';
import { StripeWebhookError } from '../billing/stripeWebhook';
import { handleStripeWebhook } from '../billing/webhookHandler';

const router = Router();

function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res, next).catch(next);
  };
}

function requireOrganizationBillingRole(write: boolean) {
  return (req: Request, res: Response, next: NextFunction) => {
    const role = req.auth?.organizationRole;
    if (role !== 'owner' && (write || role !== 'admin')) {
      return res.status(403).json({ error: 'Organization billing access denied' });
    }
    next();
  };
}

const checkoutInputSchema = z.object({
  planKey: z.string().trim().regex(/^[a-z][a-z0-9_-]{0,49}$/),
}).strict();

router.post('/webhooks/stripe', asyncRoute(async (req, res) => {
  const signature = req.header('stripe-signature');
  if (!signature || !req.rawBody) {
    return res.status(400).json({ error: 'Missing Stripe webhook signature' });
  }
  const result = await handleStripeWebhook(req.rawBody, signature);
  return res.status(result.httpStatus).json(result.body);
}));

router.use('/billing', requireAuth, requireCsrf);

router.get(
  '/billing/summary',
  requireOrganizationBillingRole(false),
  asyncRoute(async (req, res) => {
    return res.json(await getBillingSummary(req.auth!.organizationId));
  })
);

router.post(
  '/billing/checkout',
  requireOrganizationBillingRole(true),
  requireMfaForSensitiveAction,
  asyncRoute(async (req, res) => {
    const parsed = checkoutInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid plan' });
    }
    const clientIdempotency = req.header('idempotency-key')?.trim();
    if (!clientIdempotency || !/^[A-Za-z0-9._:-]{8,200}$/.test(clientIdempotency)) {
      return res.status(400).json({
        error: 'A stable Idempotency-Key header (8-200 safe characters) is required',
      });
    }

    const session = await createStripeCheckoutSession({
      organizationId: req.auth!.organizationId,
      planKey: parsed.data.planKey,
      requestIdempotencyKey: clientIdempotency,
    });
    await auditAction(req, 'billing.checkout_created', {
      organizationId: req.auth!.organizationId,
      targetType: 'StripeCheckoutSession',
      targetId: session.id,
      metadata: { planKey: parsed.data.planKey },
    });
    return res.status(201).json(session);
  })
);

router.post(
  '/billing/portal',
  requireOrganizationBillingRole(true),
  requireMfaForSensitiveAction,
  asyncRoute(async (req, res) => {
    const session = await createStripePortalSession(req.auth!.organizationId);
    await auditAction(req, 'billing.portal_created', {
      organizationId: req.auth!.organizationId,
      targetType: 'StripePortalSession',
      targetId: session.id,
    });
    return res.status(201).json(session);
  })
);

router.post(
  '/billing/budgets',
  requireOrganizationBillingRole(true),
  requireMfaForSensitiveAction,
  asyncRoute(async (req, res) => {
    const parsed = tenantBudgetInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid budget' });
    }
    if (
      parsed.data.clinicId &&
      !req.auth!.clinics.some((clinic) => (
        clinic.id === parsed.data.clinicId && clinic.organizationId === req.auth!.organizationId
      ))
    ) {
      return res.status(403).json({ error: 'Clinic access denied' });
    }

    const budget = await saveTenantBudget(req.auth!.organizationId, parsed.data);
    await auditAction(req, 'billing.budget_saved', {
      organizationId: req.auth!.organizationId,
      clinicId: budget.clinicId,
      targetType: 'TenantBudget',
      targetId: budget.id,
      metadata: { metric: budget.metric, period: budget.period },
    });
    return res.status(201).json({ budget: serializeTenantBudget(budget) });
  })
);

const billingErrorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (error instanceof StripeWebhookError) {
    return res.status(error.statusCode).json({ error: error.message });
  }
  if (req.path === '/webhooks/stripe') {
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
  if (error instanceof BillingConflictError) {
    return res.status(error.statusCode).json({ error: error.message });
  }
  if (error instanceof TenantBudgetInputError) {
    return res.status(error.statusCode).json({ error: error.message });
  }
  if (error instanceof BillingConfigurationError) {
    return res.status(error.statusCode).json({ error: 'Billing is temporarily unavailable' });
  }
  if (error instanceof UnknownBillingPlanError) {
    return res.status(error.statusCode).json({ error: error.message });
  }
  if (error instanceof StripeApiError) {
    const status = error.retryable ? 503 : 502;
    return res.status(status).json({ error: 'Billing provider request failed' });
  }
  return res.status(500).json({ error: 'Billing request failed' });
};

router.use(billingErrorHandler);

export default router;
