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
  BillingCheckoutVerificationError,
  cancelRazorpaySubscription,
  createRazorpayCheckoutSession,
  verifyRazorpayCheckout,
} from '../billing/checkout';
import { getBillingSummary } from '../billing/summary';
import { RazorpayApiError } from '../billing/razorpayClient';
import { RazorpayWebhookError } from '../billing/razorpayWebhook';
import { handleRazorpayWebhook } from '../billing/webhookHandler';

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

const checkoutProofSchema = z.object({
  checkoutIntentId: z.string().uuid(),
  razorpayPaymentId: z.string().regex(/^pay_[A-Za-z0-9]+$/),
  razorpaySubscriptionId: z.string().regex(/^sub_[A-Za-z0-9]+$/),
  razorpaySignature: z.string().regex(/^[a-fA-F0-9]{64}$/),
}).strict();

function requireIdempotencyKey(req: Request, res: Response): string | null {
  const value = req.header('idempotency-key')?.trim();
  if (!value || !/^[A-Za-z0-9._:-]{8,200}$/.test(value)) {
    res.status(400).json({
      error: 'A stable Idempotency-Key header (8-200 safe characters) is required',
    });
    return null;
  }
  return value;
}

router.post('/webhooks/razorpay', asyncRoute(async (req, res) => {
  const signature = req.header('x-razorpay-signature');
  const eventId = req.header('x-razorpay-event-id');
  if (!signature || !eventId || !req.rawBody) {
    return res.status(400).json({ error: 'Missing Razorpay webhook authentication headers' });
  }
  const result = await handleRazorpayWebhook(req.rawBody, signature, eventId);
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
    const clientIdempotency = requireIdempotencyKey(req, res);
    if (!clientIdempotency) return;

    const session = await createRazorpayCheckoutSession({
      organizationId: req.auth!.organizationId,
      planKey: parsed.data.planKey,
      requestIdempotencyKey: clientIdempotency,
    });
    await auditAction(req, 'billing.checkout_created', {
      organizationId: req.auth!.organizationId,
      targetType: 'RazorpaySubscription',
      targetId: session.subscriptionId,
      metadata: { planKey: parsed.data.planKey },
    });
    return res.status(201).json(session);
  })
);

router.post(
  '/billing/checkout/verify',
  requireOrganizationBillingRole(true),
  requireMfaForSensitiveAction,
  asyncRoute(async (req, res) => {
    if (!requireIdempotencyKey(req, res)) return;
    const parsed = checkoutProofSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error.issues[0]?.message ?? 'Invalid Razorpay checkout proof',
      });
    }
    const result = await verifyRazorpayCheckout({
      organizationId: req.auth!.organizationId,
      ...parsed.data,
    });
    await auditAction(req, 'billing.checkout_verified', {
      organizationId: req.auth!.organizationId,
      targetType: 'RazorpaySubscription',
      targetId: result.subscriptionId,
      metadata: { providerStatus: result.providerStatus },
    });
    return res.json(result);
  })
);

router.post(
  '/billing/subscription/cancel',
  requireOrganizationBillingRole(true),
  requireMfaForSensitiveAction,
  asyncRoute(async (req, res) => {
    const clientIdempotency = requireIdempotencyKey(req, res);
    if (!clientIdempotency) return;
    const parsed = z.object({}).strict().safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Cancellation body must be empty' });
    }
    const result = await cancelRazorpaySubscription(
      req.auth!.organizationId,
      clientIdempotency,
      req.auth!.userId
    );
    await auditAction(req, 'billing.subscription_cancellation_requested', {
      organizationId: req.auth!.organizationId,
      targetType: 'RazorpaySubscription',
      targetId: result.subscriptionId,
      metadata: {
        cancelAtPeriodEnd: result.cancelAtPeriodEnd,
        cancellationMode: result.cancellationMode,
      },
    });
    return res.status(202).json(result);
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
  if (error instanceof RazorpayWebhookError) {
    return res.status(error.statusCode).json({ error: error.message });
  }
  if (req.path === '/webhooks/razorpay') {
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
  if (
    error instanceof BillingConflictError ||
    error instanceof BillingCheckoutVerificationError
  ) {
    return res.status(error.statusCode).json({
      error: error.message,
      ...(error instanceof BillingConflictError &&
        error.idempotencyKeyDisposition
        ? { idempotencyKeyDisposition: error.idempotencyKeyDisposition }
        : {}),
    });
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
  if (error instanceof RazorpayApiError) {
    const status = error.retryable ? 503 : 502;
    return res.status(status).json({
      error: 'Billing provider request failed',
      idempotencyKeyDisposition: error.retryable ? 'reuse' : 'replace',
    });
  }
  return res.status(500).json({ error: 'Billing request failed' });
};

router.use(billingErrorHandler);

export default router;
