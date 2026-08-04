'use client';

import axios from 'axios';
import Link from 'next/link';
import Script from 'next/script';
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  BellRing,
  Building2,
  CalendarClock,
  CheckCircle2,
  CreditCard,
  Gauge,
  Loader2,
  PencilLine,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  WalletCards,
} from 'lucide-react';
import api, {
  createIdempotencyKey,
  type BillingSummary,
  type BillingSubscription,
  type RazorpayCancellationResult,
  type RazorpayCheckoutProof,
  type RazorpayCheckoutSession,
  type TenantBudget,
} from '@/lib/api';
import { useAuth } from '@/lib/auth';
import PageHeader from '@/components/ui/PageHeader';

const inputClass =
  'ui-input';
const selectClass = 'ui-select';

const configuredPlans = (process.env.NEXT_PUBLIC_BILLING_PLAN_KEYS ?? 'starter')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);

const RAZORPAY_CHECKOUT_SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';

type IdempotencyKeyDisposition = 'reuse' | 'replace';

function apiError(error: unknown, fallback: string): {
  message: string;
  needsMfa: boolean;
  idempotencyKeyDisposition: IdempotencyKeyDisposition | null;
} {
  if (!axios.isAxiosError(error)) {
    return {
      message: fallback,
      needsMfa: false,
      idempotencyKeyDisposition: null,
    };
  }
  const disposition = error.response?.data?.idempotencyKeyDisposition;
  return {
    message: error.response?.data?.error ?? fallback,
    needsMfa:
      error.response?.data?.mfaSetupRequired === true ||
      error.response?.data?.mfaRequired === true,
    idempotencyKeyDisposition:
      disposition === 'reuse' || disposition === 'replace'
        ? disposition
        : null,
  };
}

function currencyDigits(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency })
      .resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

function majorToMinor(value: string, currency: string): string | null {
  const clean = value.trim();
  if (!clean) return null;
  if (!/^\d{1,14}(?:\.\d+)?$/.test(clean)) throw new Error('Enter a valid non-negative amount');
  const digits = currencyDigits(currency);
  const [whole, fraction = ''] = clean.split('.');
  if (fraction.length > digits && Number(fraction.slice(digits)) !== 0) {
    throw new Error(`Use at most ${digits} decimal places for ${currency}`);
  }
  const normalizedFraction = fraction.slice(0, digits).padEnd(digits, '0');
  return BigInt(`${whole}${normalizedFraction}`).toString();
}

function minorToMajor(value: string | null, currency: string): string {
  if (!value) return '';
  const digits = currencyDigits(currency);
  const padded = value.padStart(digits + 1, '0');
  if (digits === 0) return padded;
  const whole = padded.slice(0, -digits);
  const fraction = padded.slice(-digits).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

function formatMoney(amountMinor: string, currency: string): string {
  try {
    const integer = BigInt(amountMinor);
    if (integer > BigInt(Number.MAX_SAFE_INTEGER)) {
      return `${currency} ${minorToMajor(amountMinor, currency)}`;
    }
    const divisor = 10 ** currencyDigits(currency);
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(integer) / divisor);
  } catch {
    return `${currency} ${amountMinor}`;
  }
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));
}

function metricLabel(metric: string): string {
  const labels: Record<string, string> = {
    voice_seconds: 'AI voice time',
    sms_segments: 'SMS segments',
    vapi_llm_prompt_tokens: 'Vapi LLM prompt tokens',
    vapi_llm_cached_prompt_tokens: 'Vapi cached prompt tokens',
    vapi_llm_completion_tokens: 'Vapi LLM completion tokens',
    vapi_tts_characters: 'Vapi text-to-speech characters',
  };
  return labels[metric] ?? metric.replaceAll('_', ' ');
}

const budgetMetrics = [
  'voice_seconds',
  'sms_segments',
  'vapi_llm_prompt_tokens',
  'vapi_llm_cached_prompt_tokens',
  'vapi_llm_completion_tokens',
  'vapi_tts_characters',
] as const;
const blockingBudgetMetrics = new Set<string>(['voice_seconds', 'sms_segments']);

function usageQuantity(metric: string, quantity: string): string {
  const value = Number(quantity);
  if (metric === 'voice_seconds' && Number.isFinite(value)) {
    return `${(value / 60).toLocaleString(undefined, { maximumFractionDigits: 1 })} min`;
  }
  return Number.isFinite(value)
    ? value.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : quantity;
}

function statusStyle(status: string): string {
  if (['active', 'authenticated', 'trialing'].includes(status)) return 'status-pill status-success';
  if (['created', 'pending', 'past_due', 'past_due_grace', 'unpaid', 'incomplete', 'pending_payment'].includes(status)) {
    return 'status-pill status-warning';
  }
  if (['halted', 'suspended'].includes(status)) return 'status-pill status-danger';
  return 'status-pill status-neutral';
}

function subscriptionPeriodLabel(subscription: BillingSubscription | null): string {
  if (!subscription) return 'Choose a plan to start service';
  if (subscription.trialEnd) return `Trial ends ${formatDate(subscription.trialEnd)}`;
  if (subscription.currentPeriodEnd) {
    const ends = subscription.cancelAtPeriodEnd || subscription.providerStatus === 'completed';
    return `${ends ? 'Ends' : 'Renews'} ${formatDate(subscription.currentPeriodEnd)}`;
  }
  return subscription.providerStatus === 'completed'
    ? 'Subscription completed'
    : 'Billing cycle pending';
}

function validateCheckoutSession(session: RazorpayCheckoutSession): void {
  if (
    session.provider !== 'razorpay' ||
    !session.checkoutIntentId ||
    !/^rzp_(?:test|live)_[A-Za-z0-9]+$/.test(session.keyId) ||
    !/^sub_[A-Za-z0-9]+$/.test(session.subscriptionId) ||
    !session.merchantName.trim() ||
    !session.description.trim()
  ) {
    throw new Error('The payment provider returned an invalid checkout session');
  }
  if (session.themeColor && !/^#[0-9A-Fa-f]{6}$/.test(session.themeColor)) {
    throw new Error('The payment provider returned an invalid checkout theme');
  }
}

function checkoutFailureMessage(response: RazorpayPaymentFailure): string {
  return response.error?.description || response.error?.reason || 'Razorpay could not complete the payment';
}

interface BudgetFormState {
  clinicId: string;
  metric: string;
  period: 'daily' | 'monthly' | 'billing_period';
  currency: string;
  softLimitQuantity: string;
  hardLimitQuantity: string;
  softLimitAmount: string;
  hardLimitAmount: string;
  enforcementMode: 'alert' | 'soft_block' | 'hard_block';
}

const emptyBudget: BudgetFormState = {
  clinicId: '',
  metric: 'voice_seconds',
  period: 'billing_period',
  currency: 'INR',
  softLimitQuantity: '',
  hardLimitQuantity: '',
  softLimitAmount: '',
  hardLimitAmount: '',
  enforcementMode: 'alert',
};

export default function BillingPage() {
  const {
    activeOrganizationId,
    clinics,
    canReadBilling,
    canManageBilling,
  } = useAuth();
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [needsMfa, setNeedsMfa] = useState(false);
  const [notice, setNotice] = useState('');
  const [checkoutScriptReady, setCheckoutScriptReady] = useState(false);
  const [checkoutScriptFailed, setCheckoutScriptFailed] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState(configuredPlans[0] ?? 'starter');
  const [budget, setBudget] = useState<BudgetFormState>(emptyBudget);
  const checkoutIdempotency = useRef(createIdempotencyKey('billing-checkout'));
  const cancellationIdempotency = useRef(
    createIdempotencyKey('billing-subscription-cancel')
  );

  const organizationClinics = useMemo(
    () => clinics.filter(clinic => clinic.organizationId === activeOrganizationId),
    [activeOrganizationId, clinics]
  );
  const blockingSupported = blockingBudgetMetrics.has(budget.metric);

  const loadSummary = useCallback(async () => {
    if (!canReadBilling) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const response = await api.get<BillingSummary>('/billing/summary');
      setSummary(response.data);
      if (response.data.billingAccount?.currency) {
        setBudget(current => ({ ...current, currency: response.data.billingAccount!.currency }));
      }
      if (configuredPlans.includes(response.data.organization.planKey)) {
        setSelectedPlan(response.data.organization.planKey);
      }
    } catch (requestError) {
      setError(apiError(requestError, 'Unable to load billing data').message);
    } finally {
      setLoading(false);
    }
  }, [canReadBilling]);

  useEffect(() => {
    void loadSummary();
  }, [activeOrganizationId, loadSummary]);

  const startCheckout = async () => {
    setBusyAction('checkout');
    setError('');
    setNeedsMfa(false);
    setNotice('');
    try {
      const Razorpay = window.Razorpay;
      if (!checkoutScriptReady || !Razorpay) {
        throw new Error(
          checkoutScriptFailed
            ? 'Razorpay Checkout could not be loaded. Check your connection and refresh the page.'
            : 'Razorpay Checkout is still loading. Please try again in a moment.'
        );
      }

      const response = await api.post<RazorpayCheckoutSession>(
        '/billing/checkout',
        { planKey: selectedPlan },
        { headers: { 'Idempotency-Key': checkoutIdempotency.current } }
      );
      const session = response.data;
      validateCheckoutSession(session);

      let paymentHandled = false;
      const checkout = new Razorpay({
        key: session.keyId,
        subscription_id: session.subscriptionId,
        name: session.merchantName,
        description: session.description,
        prefill: session.prefill,
        theme: session.themeColor ? { color: session.themeColor } : undefined,
        modal: {
          confirm_close: true,
          ondismiss: () => {
            if (!paymentHandled) {
              setNotice('Checkout was closed. No subscription access change has been made.');
            }
          },
        },
        handler: async paymentResponse => {
          paymentHandled = true;
          setBusyAction('verify-checkout');
          setError('');
          setNeedsMfa(false);
          try {
            if (paymentResponse.razorpay_subscription_id !== session.subscriptionId) {
              throw new Error('Razorpay returned a subscription that does not match this checkout');
            }
            const proof: RazorpayCheckoutProof = {
              checkoutIntentId: session.checkoutIntentId,
              razorpayPaymentId: paymentResponse.razorpay_payment_id,
              razorpaySubscriptionId: paymentResponse.razorpay_subscription_id,
              razorpaySignature: paymentResponse.razorpay_signature,
            };
            await api.post('/billing/checkout/verify', proof, {
              headers: { 'Idempotency-Key': createIdempotencyKey('billing-checkout-verify') },
            });
            checkoutIdempotency.current = createIdempotencyKey('billing-checkout');
            setNotice('Payment verified. Your subscription access has been reconciled.');
            await loadSummary();
          } catch (requestError) {
            const detail = apiError(
              requestError,
              requestError instanceof Error ? requestError.message : 'Unable to verify the Razorpay checkout'
            );
            setError(detail.message);
            setNeedsMfa(detail.needsMfa);
          } finally {
            setBusyAction(null);
          }
        },
      });

      checkout.on('payment.failed', paymentResponse => {
        paymentHandled = true;
        setBusyAction(null);
        setNotice('');
        setError(checkoutFailureMessage(paymentResponse));
      });
      checkout.open();
    } catch (requestError) {
      const detail = apiError(requestError, requestError instanceof Error ? requestError.message : 'Unable to start checkout');
      if (detail.idempotencyKeyDisposition === 'replace') {
        checkoutIdempotency.current = createIdempotencyKey('billing-checkout');
      }
      setError(detail.message);
      setNeedsMfa(detail.needsMfa);
    } finally {
      setBusyAction(null);
    }
  };

  const cancelSubscription = async () => {
    const cancellationMode = summary?.subscription?.cancellationMode;
    if (!cancellationMode) return;
    const immediate = cancellationMode === 'immediate';
    const confirmed = window.confirm(
      immediate
        ? 'Cancel this trial now? Subscription access will end immediately.'
        : 'Cancel renewal at the end of the current billing cycle? Paid access will continue until then.'
    );
    if (!confirmed) return;

    setBusyAction('cancel-subscription');
    setError('');
    setNeedsMfa(false);
    setNotice('');
    try {
      const response = await api.post<RazorpayCancellationResult>(
        '/billing/subscription/cancel',
        {},
        { headers: { 'Idempotency-Key': cancellationIdempotency.current } }
      );
      cancellationIdempotency.current =
        createIdempotencyKey('billing-subscription-cancel');
      setNotice(
        response.data.cancellationMode === 'immediate'
          ? 'Subscription cancelled. Access has ended.'
          : `Renewal cancelled. Paid access continues${
              response.data.currentPeriodEnd
                ? ` through ${formatDate(response.data.currentPeriodEnd)}`
                : ' through the current billing cycle'
            }.`
      );
      await loadSummary();
    } catch (requestError) {
      const detail = apiError(
        requestError,
        requestError instanceof Error ? requestError.message : 'Unable to cancel the subscription'
      );
      if (detail.idempotencyKeyDisposition === 'replace') {
        cancellationIdempotency.current =
          createIdempotencyKey('billing-subscription-cancel');
      }
      setError(detail.message);
      setNeedsMfa(detail.needsMfa);
    } finally {
      setBusyAction(null);
    }
  };

  const editBudget = (existing: TenantBudget) => {
    const currency = existing.currency ?? summary?.billingAccount?.currency ?? 'INR';
    setBudget({
      clinicId: existing.clinicId ?? '',
      metric: existing.metric,
      period: existing.period,
      currency,
      softLimitQuantity: existing.softLimitQuantity ?? '',
      hardLimitQuantity: existing.hardLimitQuantity ?? '',
      softLimitAmount: minorToMajor(existing.softLimitAmountMinor, currency),
      hardLimitAmount: minorToMajor(existing.hardLimitAmountMinor, currency),
      enforcementMode: existing.enforcementMode,
    });
    document.getElementById('budget-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const saveBudget = async (event: FormEvent) => {
    event.preventDefault();
    setBusyAction('budget');
    setError('');
    setNeedsMfa(false);
    try {
      const payload = {
        clinicId: budget.clinicId || null,
        metric: budget.metric,
        period: budget.period,
        currency: budget.currency.toUpperCase(),
        softLimitQuantity: budget.softLimitQuantity || null,
        hardLimitQuantity: budget.hardLimitQuantity || null,
        softLimitAmountMinor: majorToMinor(budget.softLimitAmount, budget.currency),
        hardLimitAmountMinor: majorToMinor(budget.hardLimitAmount, budget.currency),
        enforcementMode: budget.enforcementMode,
        alertThresholds: [50, 75, 90, 100],
      };
      if (
        !payload.softLimitQuantity &&
        !payload.hardLimitQuantity &&
        !payload.softLimitAmountMinor &&
        !payload.hardLimitAmountMinor
      ) {
        throw new Error('Add at least one usage or monetary limit');
      }
      await api.post('/billing/budgets', payload, {
        headers: { 'Idempotency-Key': createIdempotencyKey('billing-budget') },
      });
      setNotice('Budget controls saved.');
      await loadSummary();
    } catch (requestError) {
      const detail = apiError(requestError, requestError instanceof Error ? requestError.message : 'Unable to save budget');
      setError(detail.message);
      setNeedsMfa(detail.needsMfa);
    } finally {
      setBusyAction(null);
    }
  };

  if (!canReadBilling) {
    return (
      <div className="page-shell flex min-h-[70dvh] items-center justify-center">
        <div className="surface-card w-full max-w-lg px-6 py-12 text-center sm:px-10">
          <span className="empty-illustration">
            <ShieldAlert className="h-5 w-5" />
          </span>
          <p className="page-eyebrow mt-5 justify-center">Protected workspace</p>
          <h1 className="page-title text-[1.8rem]">Billing access required</h1>
          <p className="page-description mx-auto">
            Only organization owners and administrators can view subscription and usage details.
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="page-shell" role="status" aria-busy="true" aria-label="Loading billing and usage">
        <div className="mb-8 space-y-3">
          <div className="skeleton h-3 w-28" />
          <div className="skeleton h-10 w-64" />
          <div className="skeleton h-4 w-full max-w-lg" />
        </div>
        <div className="skeleton h-64 w-full rounded-[1.35rem]" />
        <div className="mt-5 grid gap-4 md:grid-cols-3">
          <div className="skeleton h-32" />
          <div className="skeleton h-32" />
          <div className="skeleton h-32" />
        </div>
      </div>
    );
  }

  return (
    <>
      <Script
        id="razorpay-checkout"
        src={RAZORPAY_CHECKOUT_SCRIPT}
        strategy="afterInteractive"
        onReady={() => {
          setCheckoutScriptReady(true);
          setCheckoutScriptFailed(false);
        }}
        onError={() => {
          setCheckoutScriptReady(false);
          setCheckoutScriptFailed(true);
        }}
      />
      <div className="page-shell">
      <PageHeader
        eyebrow="Revenue operations"
        title="Billing & usage"
        description="A clear view of subscription access, current consumption, and the safeguards protecting your spend."
        icon={CreditCard}
        actions={(
          <button
            type="button"
            onClick={() => void loadSummary()}
            disabled={loading}
            className="btn-secondary"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh data
          </button>
        )}
      />

      {notice && (
        <div className="alert-success mb-5" role="status" aria-live="polite">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{notice}</span>
        </div>
      )}
      {error && (
        <div className="alert-error mb-5" role="alert">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <p>{error}</p>
            {needsMfa && <Link href="/mfa" className="mt-2 inline-flex font-bold text-danger underline decoration-danger/30 underline-offset-4 hover:decoration-danger">Set up or verify MFA</Link>}
          </div>
        </div>
      )}

      {summary && (
        <>
          <section className="relative overflow-hidden rounded-[1.35rem] border border-[#28483e] bg-nav p-5 text-white shadow-[0_18px_45px_rgba(18,39,32,0.16)] sm:p-7">
            <div className="pointer-events-none absolute -right-20 -top-24 h-72 w-72 rounded-full border border-white/[0.07]" />
            <div className="pointer-events-none absolute -right-6 -top-8 h-44 w-44 rounded-full border border-white/[0.06]" />
            <div className="relative grid gap-7 lg:grid-cols-[1.3fr_0.7fr] lg:items-start">
              <div>
                <p className="inline-flex items-center gap-2 text-[0.66rem] font-bold uppercase tracking-[0.16em] text-[#9fc1b5]">
                  <Sparkles className="h-3.5 w-3.5 text-[#d8b76e]" /> Current subscription
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <h2 className="font-display text-4xl font-medium capitalize tracking-[-0.045em] text-white sm:text-5xl">
                    {(summary.subscription?.planKey ?? summary.organization.planKey).replaceAll('_', ' ')}
                  </h2>
                  <span className={statusStyle(summary.subscription?.status ?? 'not_started')}>
                    {summary.subscription?.status.replaceAll('_', ' ') ?? 'Not started'}
                  </span>
                </div>
                <p className="mt-3 text-sm text-[#acc5bc]">{subscriptionPeriodLabel(summary.subscription)}</p>

                <div className="mt-6 flex flex-wrap gap-x-8 gap-y-4 border-t border-white/[0.09] pt-5">
                  <div>
                    <p className="text-[0.62rem] font-bold uppercase tracking-[0.14em] text-[#78998e]">Organization access</p>
                    <p className="mt-1.5 text-sm font-semibold capitalize text-[#f2f8f5]">{summary.organization.status.replaceAll('_', ' ')}</p>
                  </div>
                  <div>
                    <p className="text-[0.62rem] font-bold uppercase tracking-[0.14em] text-[#78998e]">Billing provider</p>
                    <p className="mt-1.5 text-sm font-semibold capitalize text-[#f2f8f5]">{summary.billingAccount?.provider ?? 'Not connected'}</p>
                  </div>
                  <div>
                    <p className="text-[0.62rem] font-bold uppercase tracking-[0.14em] text-[#78998e]">Usage period</p>
                    <p className="mt-1.5 text-sm font-semibold text-[#f2f8f5]">{formatDate(summary.period.start)} – {formatDate(summary.period.end)}</p>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-white/[0.11] bg-white/[0.07] p-5 backdrop-blur">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[0.66rem] font-bold uppercase tracking-[0.14em] text-[#9fc1b5]">Current, unfinalized usage estimate</p>
                  <Gauge className="h-4 w-4 text-[#92cdbb]" />
                </div>
                <div className="mt-4 space-y-1">
                  {summary.estimate.amounts.length > 0 ? summary.estimate.amounts.map(amount => (
                    <p key={amount.currency} className="text-3xl font-semibold tracking-[-0.04em] text-white">
                      {formatMoney(amount.amountMinor, amount.currency)}
                    </p>
                  )) : <p className="text-2xl font-semibold text-white">No rated usage</p>}
                </div>
                <p className="mt-3 text-[0.68rem] leading-5 text-[#91ada4]">Excludes base fees, taxes, discounts, and unrated events.</p>
              </div>
            </div>

            <div className="relative mt-6 border-t border-white/[0.09] pt-5">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
                <div>
                  <p className="text-sm font-semibold text-white">Subscription controls</p>
                  <p className="mt-1 max-w-2xl text-xs leading-5 text-[#93aea5]">
                  {summary.billingAccount && summary.billingAccount.provider !== 'razorpay'
                    ? 'This organization uses a legacy Stripe billing account. Billing changes are disabled until an operator completes the Razorpay cutover.'
                    : 'Payment authorization is securely handled by Razorpay Checkout.'}
                  </p>
                </div>
                {canManageBilling ? (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  {summary.actions.canStartCheckout &&
                    (!summary.billingAccount || summary.billingAccount.provider === 'razorpay') && (
                    <>
                      <label className="sr-only" htmlFor="billing-plan">Choose subscription plan</label>
                      <select id="billing-plan" value={selectedPlan} onChange={event => setSelectedPlan(event.target.value)} className="ui-select min-w-40 border-white/20 bg-white text-ink">
                        {configuredPlans.map(plan => <option key={plan} value={plan}>{plan}</option>)}
                      </select>
                      <button
                        type="button"
                        onClick={startCheckout}
                        disabled={busyAction !== null || !checkoutScriptReady}
                        className="btn-primary btn-inverse whitespace-nowrap"
                      >
                        {busyAction === 'checkout' || busyAction === 'verify-checkout' || (!checkoutScriptReady && !checkoutScriptFailed)
                          ? <Loader2 className="h-4 w-4 animate-spin" />
                          : <WalletCards className="h-4 w-4" />}
                        {busyAction === 'verify-checkout'
                          ? 'Verifying payment'
                          : busyAction === 'checkout'
                            ? 'Opening checkout'
                            : checkoutScriptFailed
                              ? 'Payments unavailable'
                              : checkoutScriptReady
                                ? 'Choose plan'
                                : 'Loading payments'}
                      </button>
                    </>
                  )}
                  {summary.billingAccount?.provider === 'razorpay' &&
                    summary.subscription?.canCancel && (
                    <button
                      type="button"
                      onClick={cancelSubscription}
                      disabled={busyAction !== null}
                      className="inline-flex min-h-[2.65rem] items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-[#ba7770]/50 px-4 py-2 text-xs font-bold text-[#f0b9b3] transition-colors hover:bg-[#763a35]/30 disabled:opacity-50"
                    >
                      {busyAction === 'cancel-subscription' && <Loader2 className="h-4 w-4 animate-spin" />}
                      {summary.subscription.cancellationMode === 'immediate'
                        ? 'Cancel now'
                        : 'Cancel renewal'}
                    </button>
                  )}
                </div>
                ) : (
                  <p className="text-xs text-[#93aea5]">Only the organization owner can change billing.</p>
                )}
              </div>
            {summary.subscription?.cancelAtPeriodEnd && (
              <p className="mt-4 rounded-xl border border-[#9d7a3d]/35 bg-[#6e5428]/20 px-3 py-2.5 text-xs text-[#e7c987]">
                Renewal is cancelled. Access continues
                {summary.subscription.currentPeriodEnd
                  ? ` through ${formatDate(summary.subscription.currentPeriodEnd)}`
                  : ' through the current billing cycle'}.
              </p>
            )}
            {summary.subscription?.canCancel &&
              summary.subscription.cancellationMode === 'immediate' && (
                <p className="mt-4 rounded-xl border border-[#9d7a3d]/35 bg-[#6e5428]/20 px-3 py-2.5 text-xs text-[#e7c987]">
                  This subscription has not begun a paid billing cycle. Cancelling it will end access immediately.
                </p>
              )}
            {checkoutScriptFailed &&
              canManageBilling &&
              summary.actions.canStartCheckout &&
              (!summary.billingAccount || summary.billingAccount.provider === 'razorpay') && (
              <p className="mt-4 rounded-xl border border-[#9f5b55]/40 bg-[#6e342f]/20 px-3 py-2.5 text-xs text-[#efb2ac]">
                Razorpay Checkout could not be loaded. Check your connection or content blocker, then refresh this page.
              </p>
            )}
            </div>
          </section>

          <section className="surface-card mt-5 overflow-hidden">
            <div className="surface-header">
              <div className="flex items-start gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#d3e6df] bg-brand-softer text-brand">
                  <BarChart3 className="h-4 w-4" />
                </span>
                <div>
                  <p className="section-kicker mb-1">Consumption ledger</p>
                  <h2 className="section-title">Usage this billing period</h2>
                  <p className="section-description">{formatDate(summary.period.start)} – {formatDate(summary.period.end)}</p>
                </div>
              </div>
              <span className="status-pill status-neutral">{summary.usage.length} usage rows</span>
            </div>
            {summary.usage.length === 0 ? (
              <div className="px-6 py-16 text-center">
                <span className="empty-illustration"><BarChart3 className="h-5 w-5" /></span>
                <p className="mt-4 text-sm font-semibold text-ink">No usage recorded</p>
                <p className="mt-1 text-xs text-muted">Activity for this billing period will appear here.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-sm" aria-label="Usage recorded in this billing period">
                  <thead className="data-header">
                    <tr><th scope="col" className="px-5 py-3.5">Metric</th><th scope="col" className="px-5 py-3.5">Clinic</th><th scope="col" className="px-5 py-3.5">Quantity</th><th scope="col" className="px-5 py-3.5">Estimate</th><th scope="col" className="px-5 py-3.5">Events</th></tr>
                  </thead>
                  <tbody>
                    {summary.usage.map((usage, index) => (
                      <tr key={`${usage.metric}-${usage.clinicId ?? 'org'}-${index}`} className="data-row">
                        <td className="px-5 py-4 font-semibold text-ink">{metricLabel(usage.metric)}</td>
                        <td className="px-5 py-4 text-muted">{usage.clinicName ?? 'Organization-wide'}</td>
                        <td className="px-5 py-4 font-medium text-ink-soft">{usageQuantity(usage.metric, usage.quantity)}</td>
                        <td className="px-5 py-4 font-medium text-ink-soft">{usage.ratedAmountMinor && usage.currency ? formatMoney(usage.ratedAmountMinor, usage.currency) : <span className="status-pill status-neutral">Pending rating</span>}</td>
                        <td className="px-5 py-4 text-muted">{usage.eventCount}{usage.unratedEventCount > 0 ? ` (${usage.unratedEventCount} unrated)` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <div className="mt-5 grid items-start gap-5 xl:grid-cols-[1.08fr_0.92fr]">
            <section className="surface-card overflow-hidden">
              <div className="surface-header">
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#d3e6df] bg-brand-softer text-brand">
                    <BellRing className="h-4 w-4" />
                  </span>
                  <div>
                    <p className="section-kicker mb-1">Guardrails</p>
                    <h2 className="section-title">Budgets & spend protection</h2>
                    <p className="section-description">Policies that alert or pause service before spend gets away from you.</p>
                  </div>
                </div>
                <span className="status-pill status-neutral">{summary.budgets.length} active</span>
              </div>
              <div className="p-4 sm:p-5">
              {summary.budgets.length === 0 ? (
                <div className="py-9 text-center">
                  <span className="empty-illustration"><BellRing className="h-5 w-5" /></span>
                  <p className="mt-4 text-sm font-semibold text-ink">No active budget controls</p>
                  <p className="mt-1 text-xs text-muted">Create a policy to receive usage and spend alerts.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {summary.budgets.map(existing => {
                    const currency = existing.currency ?? summary.billingAccount?.currency ?? 'INR';
                    return (
                      <div key={existing.id} className="surface-card-soft p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-sm font-semibold text-ink">{metricLabel(existing.metric)}</p>
                              <span className={`status-pill ${existing.enforcementMode === 'alert' ? 'status-info' : 'status-warning'}`}>{existing.enforcementMode.replaceAll('_', ' ')}</span>
                            </div>
                            <p className="mt-1 text-[0.7rem] font-medium capitalize text-muted">{existing.period.replaceAll('_', ' ')}</p>
                            <p className="mt-2 text-xs leading-5 text-ink-soft">
                              {existing.softLimitQuantity && `Alert at ${existing.softLimitQuantity} units`}
                              {existing.softLimitQuantity && existing.hardLimitQuantity && ' · '}
                              {existing.hardLimitQuantity && `Limit ${existing.hardLimitQuantity} units`}
                              {(existing.softLimitAmountMinor || existing.hardLimitAmountMinor) && (
                                ` · ${existing.softLimitAmountMinor ? formatMoney(existing.softLimitAmountMinor, currency) : '—'} / ${existing.hardLimitAmountMinor ? formatMoney(existing.hardLimitAmountMinor, currency) : '—'}`
                              )}
                            </p>
                          </div>
                          {canManageBilling && <button type="button" onClick={() => editBudget(existing)} className="btn-ghost btn-compact shrink-0"><PencilLine className="h-3.5 w-3.5" /> Edit</button>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              </div>
            </section>

            {canManageBilling && (
              <form id="budget-form" onSubmit={saveBudget} className="surface-card scroll-mt-6 overflow-hidden">
                <div className="surface-header">
                  <div className="flex items-start gap-3">
                    <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#d3e6df] bg-brand-softer text-brand"><Building2 className="h-4 w-4" /></span>
                    <div>
                      <p className="section-kicker mb-1">Policy editor</p>
                      <h2 className="section-title">Set a budget</h2>
                      <p className="section-description">Add at least one warning or hard limit.</p>
                    </div>
                  </div>
                </div>
                <div className="grid gap-4 p-4 sm:grid-cols-2 sm:p-5">
                  <label className="ui-label">Scope
                    <select value={budget.clinicId} onChange={event => setBudget(current => ({ ...current, clinicId: event.target.value }))} className={`${selectClass} mt-1.5`}>
                      <option value="">Organization-wide</option>
                      {organizationClinics.map(clinic => <option key={clinic.id} value={clinic.id}>{clinic.name}</option>)}
                    </select>
                  </label>
                  <label className="ui-label">Metric
                    <select value={budget.metric} onChange={event => {
                      const selectedMetric = event.target.value;
                      setBudget(current => ({
                        ...current,
                        metric: selectedMetric,
                        ...(!blockingBudgetMetrics.has(selectedMetric) ? {
                          enforcementMode: 'alert' as const,
                          hardLimitQuantity: '',
                          hardLimitAmount: '',
                        } : {}),
                      }));
                    }} className={`${selectClass} mt-1.5`}>
                      {budgetMetrics.map(metric => (
                        <option key={metric} value={metric}>{metricLabel(metric)}</option>
                      ))}
                    </select>
                  </label>
                  <label className="ui-label">Period
                    <select value={budget.period} onChange={event => setBudget(current => ({ ...current, period: event.target.value as BudgetFormState['period'] }))} className={`${selectClass} mt-1.5`}>
                      <option value="billing_period">Billing period</option><option value="monthly">Calendar month (UTC)</option><option value="daily">Daily (UTC)</option>
                    </select>
                  </label>
                  <label className="ui-label">Enforcement
                    <select value={blockingSupported ? budget.enforcementMode : 'alert'} disabled={!blockingSupported} onChange={event => setBudget(current => ({ ...current, enforcementMode: event.target.value as BudgetFormState['enforcementMode'] }))} className={`${selectClass} mt-1.5 disabled:opacity-60`}>
                      <option value="alert">Alerts only</option><option value="soft_block">Soft block</option><option value="hard_block">Hard block</option>
                    </select>
                  </label>
                  <label className="ui-label">Soft usage limit
                    <input value={budget.softLimitQuantity} onChange={event => setBudget(current => ({ ...current, softLimitQuantity: event.target.value }))} inputMode="decimal" className={`${inputClass} mt-1.5`} placeholder="e.g. 3000" />
                  </label>
                  {blockingSupported && <label className="ui-label">Hard usage limit
                    <input value={budget.hardLimitQuantity} onChange={event => setBudget(current => ({ ...current, hardLimitQuantity: event.target.value }))} inputMode="decimal" className={`${inputClass} mt-1.5`} placeholder="e.g. 5000" />
                  </label>}
                  <label className="ui-label">Soft spend alert ({budget.currency})
                    <input value={budget.softLimitAmount} onChange={event => setBudget(current => ({ ...current, softLimitAmount: event.target.value }))} inputMode="decimal" className={`${inputClass} mt-1.5`} placeholder="e.g. 500" />
                  </label>
                  {blockingSupported && <label className="ui-label">Hard spend limit ({budget.currency})
                    <input value={budget.hardLimitAmount} onChange={event => setBudget(current => ({ ...current, hardLimitAmount: event.target.value }))} inputMode="decimal" className={`${inputClass} mt-1.5`} placeholder="e.g. 750" />
                  </label>}
                  {!blockingSupported && <div className="alert-warning sm:col-span-2"><CalendarClock className="mt-0.5 h-4 w-4 shrink-0" />This provider reports the metric after a call, so it supports threshold alerts only. Voice-time limits remain the pre-call spend guard.</div>}
                  <button type="submit" disabled={busyAction !== null} className="btn-primary sm:col-span-2">
                    {busyAction === 'budget' && <Loader2 className="h-4 w-4 animate-spin" />} Save budget policy
                  </button>
                </div>
              </form>
            )}
          </div>
        </>
      )}
      </div>
    </>
  );
}
