'use client';

import axios from 'axios';
import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  BellRing,
  CheckCircle2,
  CreditCard,
  Loader2,
  RefreshCw,
  ShieldAlert,
  WalletCards,
} from 'lucide-react';
import api, {
  createIdempotencyKey,
  type BillingSummary,
  type HostedBillingSession,
  type TenantBudget,
} from '@/lib/api';
import { useAuth } from '@/lib/auth';

const inputClass =
  'w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500';

const configuredPlans = (process.env.NEXT_PUBLIC_BILLING_PLAN_KEYS ?? 'starter')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);

function apiError(error: unknown, fallback: string): { message: string; needsMfa: boolean } {
  if (!axios.isAxiosError(error)) return { message: fallback, needsMfa: false };
  return {
    message: error.response?.data?.error ?? fallback,
    needsMfa:
      error.response?.data?.mfaSetupRequired === true ||
      error.response?.data?.mfaRequired === true,
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
  if (['active', 'trialing'].includes(status)) return 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20';
  if (['past_due', 'unpaid', 'incomplete'].includes(status)) return 'bg-amber-500/10 text-amber-300 border-amber-500/20';
  return 'bg-gray-800 text-gray-300 border-gray-700';
}

function mayStartCheckout(status: string | undefined): boolean {
  return !status || ['canceled', 'incomplete_expired'].includes(status);
}

function isTrustedBillingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && (url.hostname === 'stripe.com' || url.hostname.endsWith('.stripe.com'))) {
      return true;
    }
    return process.env.NODE_ENV !== 'production' && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  } catch {
    return false;
  }
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
  const [selectedPlan, setSelectedPlan] = useState(configuredPlans[0] ?? 'starter');
  const [budget, setBudget] = useState<BudgetFormState>(emptyBudget);
  const checkoutIdempotency = useRef(createIdempotencyKey('billing-checkout'));

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

  useEffect(() => {
    const result = new URLSearchParams(window.location.search).get('checkout');
    if (result === 'success') setNotice('Checkout completed. Subscription access updates after the signed billing webhook is processed.');
    if (result === 'cancelled') setNotice('Checkout was cancelled. No subscription change was made.');
  }, []);

  const redirectToHostedSession = (session: HostedBillingSession) => {
    if (!isTrustedBillingUrl(session.url)) throw new Error('Billing provider returned an untrusted redirect URL');
    window.location.assign(session.url);
  };

  const startCheckout = async () => {
    setBusyAction('checkout');
    setError('');
    setNeedsMfa(false);
    try {
      const response = await api.post<HostedBillingSession>(
        '/billing/checkout',
        { planKey: selectedPlan },
        { headers: { 'Idempotency-Key': checkoutIdempotency.current } }
      );
      redirectToHostedSession(response.data);
    } catch (requestError) {
      const detail = apiError(requestError, requestError instanceof Error ? requestError.message : 'Unable to start checkout');
      setError(detail.message);
      setNeedsMfa(detail.needsMfa);
    } finally {
      setBusyAction(null);
    }
  };

  const openPortal = async () => {
    setBusyAction('portal');
    setError('');
    setNeedsMfa(false);
    try {
      const response = await api.post<HostedBillingSession>(
        '/billing/portal',
        {},
        { headers: { 'Idempotency-Key': createIdempotencyKey('billing-portal') } }
      );
      redirectToHostedSession(response.data);
    } catch (requestError) {
      const detail = apiError(requestError, requestError instanceof Error ? requestError.message : 'Unable to open billing portal');
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
      <div className="p-8">
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-8 text-center">
          <ShieldAlert className="mx-auto h-8 w-8 text-gray-600" />
          <h1 className="mt-3 text-lg font-semibold text-white">Billing access required</h1>
          <p className="mt-1 text-sm text-gray-500">Only organization owners and administrators can view billing.</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return <div className="flex h-screen items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-blue-500" /></div>;
  }

  return (
    <div className="p-4 md:p-6 lg:p-8">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Billing & usage</h1>
          <p className="mt-1 text-sm text-gray-400">Current consumption, subscription access, and spend protection.</p>
        </div>
        <button
          type="button"
          onClick={() => void loadSummary()}
          disabled={loading}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:bg-gray-800"
        >
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      {notice && (
        <div className="mb-5 flex items-start gap-3 rounded-lg border border-blue-500/20 bg-blue-500/10 p-3 text-sm text-blue-200">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{notice}</span>
        </div>
      )}
      {error && (
        <div className="mb-5 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">
          <div className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}</div>
          {needsMfa && <Link href="/mfa" className="mt-2 inline-block font-medium text-blue-300 hover:text-blue-200">Set up or verify MFA</Link>}
        </div>
      )}

      {summary && (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
              <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Organization access</p>
              <div className="mt-3 flex items-center justify-between gap-3">
                <p className="text-xl font-semibold capitalize text-white">{summary.organization.status.replaceAll('_', ' ')}</p>
                <span className={`rounded-full border px-2.5 py-1 text-xs ${statusStyle(summary.organization.status)}`}>{summary.organization.status}</span>
              </div>
              <p className="mt-3 text-xs text-gray-500">Plan: {summary.subscription?.planKey ?? summary.organization.planKey}</p>
            </section>

            <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
              <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Subscription</p>
              <div className="mt-3 flex items-center justify-between gap-3">
                <p className="text-xl font-semibold capitalize text-white">{summary.subscription?.status.replaceAll('_', ' ') ?? 'Not started'}</p>
                <CreditCard className="h-5 w-5 text-blue-400" />
              </div>
              <p className="mt-3 text-xs text-gray-500">
                {summary.subscription?.currentPeriodEnd
                  ? `Renews ${formatDate(summary.subscription.currentPeriodEnd)}`
                  : 'Choose a plan to start service'}
              </p>
            </section>

            <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
              <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Unfinalized usage estimate</p>
              <div className="mt-3 space-y-1">
                {summary.estimate.amounts.length > 0 ? summary.estimate.amounts.map(amount => (
                  <p key={amount.currency} className="text-xl font-semibold text-white">
                    {formatMoney(amount.amountMinor, amount.currency)}
                  </p>
                )) : <p className="text-xl font-semibold text-white">No rated usage</p>}
              </div>
              <p className="mt-3 text-xs text-gray-500">Excludes base fees, taxes, discounts, and unrated events.</p>
            </section>
          </div>

          <section className="mt-5 rounded-xl border border-gray-800 bg-gray-900 p-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="font-semibold text-white">Subscription controls</h2>
                <p className="mt-1 text-xs text-gray-500">Payment details are handled on Stripe-hosted pages.</p>
              </div>
              {canManageBilling ? (
                <div className="flex flex-col gap-2 sm:flex-row">
                  {mayStartCheckout(summary.subscription?.status) && (
                    <>
                      <select value={selectedPlan} onChange={event => setSelectedPlan(event.target.value)} className={inputClass}>
                        {configuredPlans.map(plan => <option key={plan} value={plan}>{plan}</option>)}
                      </select>
                      <button
                        type="button"
                        onClick={startCheckout}
                        disabled={busyAction !== null}
                        className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        {busyAction === 'checkout' ? <Loader2 className="h-4 w-4 animate-spin" /> : <WalletCards className="h-4 w-4" />}
                        Choose plan
                      </button>
                    </>
                  )}
                  {summary.billingAccount && (
                    <button
                      type="button"
                      onClick={openPortal}
                      disabled={busyAction !== null}
                      className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-gray-700 px-4 py-2.5 text-sm font-medium text-gray-200 hover:bg-gray-800 disabled:opacity-50"
                    >
                      {busyAction === 'portal' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUpRight className="h-4 w-4" />}
                      Payment portal
                    </button>
                  )}
                </div>
              ) : (
                <p className="text-xs text-gray-500">Only the organization owner can change billing.</p>
              )}
            </div>
          </section>

          <section className="mt-5 overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
            <div className="border-b border-gray-800 p-5">
              <h2 className="font-semibold text-white">Usage this billing period</h2>
              <p className="mt-1 text-xs text-gray-500">{formatDate(summary.period.start)} – {formatDate(summary.period.end)}</p>
            </div>
            {summary.usage.length === 0 ? (
              <p className="p-8 text-center text-sm text-gray-500">No usage has been recorded in this period.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-gray-950/50 text-xs uppercase text-gray-500">
                    <tr><th className="px-5 py-3">Metric</th><th className="px-5 py-3">Clinic</th><th className="px-5 py-3">Quantity</th><th className="px-5 py-3">Estimate</th><th className="px-5 py-3">Events</th></tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {summary.usage.map((usage, index) => (
                      <tr key={`${usage.metric}-${usage.clinicId ?? 'org'}-${index}`}>
                        <td className="px-5 py-4 font-medium text-gray-200">{metricLabel(usage.metric)}</td>
                        <td className="px-5 py-4 text-gray-400">{usage.clinicName ?? 'Organization-wide'}</td>
                        <td className="px-5 py-4 text-gray-300">{usageQuantity(usage.metric, usage.quantity)}</td>
                        <td className="px-5 py-4 text-gray-300">{usage.ratedAmountMinor && usage.currency ? formatMoney(usage.ratedAmountMinor, usage.currency) : 'Pending rating'}</td>
                        <td className="px-5 py-4 text-gray-500">{usage.eventCount}{usage.unratedEventCount > 0 ? ` (${usage.unratedEventCount} unrated)` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <div className="mt-5 grid gap-5 xl:grid-cols-[1.1fr_0.9fr]">
            <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
              <div className="mb-4 flex items-center gap-2">
                <BellRing className="h-4 w-4 text-blue-400" />
                <h2 className="font-semibold text-white">Budgets and spend protection</h2>
              </div>
              {summary.budgets.length === 0 ? (
                <p className="text-sm text-gray-500">No active budget controls.</p>
              ) : (
                <div className="space-y-3">
                  {summary.budgets.map(existing => {
                    const currency = existing.currency ?? summary.billingAccount?.currency ?? 'INR';
                    return (
                      <div key={existing.id} className="rounded-lg border border-gray-800 bg-gray-950/40 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="font-medium text-gray-200">{metricLabel(existing.metric)}</p>
                            <p className="mt-1 text-xs text-gray-500">{existing.period.replaceAll('_', ' ')} · {existing.enforcementMode.replaceAll('_', ' ')}</p>
                            <p className="mt-2 text-xs text-gray-400">
                              {existing.softLimitQuantity && `Alert at ${existing.softLimitQuantity} units`}
                              {existing.softLimitQuantity && existing.hardLimitQuantity && ' · '}
                              {existing.hardLimitQuantity && `Limit ${existing.hardLimitQuantity} units`}
                              {(existing.softLimitAmountMinor || existing.hardLimitAmountMinor) && (
                                ` · ${existing.softLimitAmountMinor ? formatMoney(existing.softLimitAmountMinor, currency) : '—'} / ${existing.hardLimitAmountMinor ? formatMoney(existing.hardLimitAmountMinor, currency) : '—'}`
                              )}
                            </p>
                          </div>
                          {canManageBilling && <button type="button" onClick={() => editBudget(existing)} className="text-xs font-medium text-blue-400 hover:text-blue-300">Edit</button>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {canManageBilling && (
              <form id="budget-form" onSubmit={saveBudget} className="rounded-xl border border-gray-800 bg-gray-900 p-5 scroll-mt-6">
                <h2 className="font-semibold text-white">Set a budget</h2>
                <p className="mt-1 text-xs text-gray-500">Configure at least one warning or hard limit for usage the service records today.</p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <label className="text-xs text-gray-400">Scope
                    <select value={budget.clinicId} onChange={event => setBudget(current => ({ ...current, clinicId: event.target.value }))} className={`${inputClass} mt-1.5`}>
                      <option value="">Organization-wide</option>
                      {organizationClinics.map(clinic => <option key={clinic.id} value={clinic.id}>{clinic.name}</option>)}
                    </select>
                  </label>
                  <label className="text-xs text-gray-400">Metric
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
                    }} className={`${inputClass} mt-1.5`}>
                      {budgetMetrics.map(metric => (
                        <option key={metric} value={metric}>{metricLabel(metric)}</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-gray-400">Period
                    <select value={budget.period} onChange={event => setBudget(current => ({ ...current, period: event.target.value as BudgetFormState['period'] }))} className={`${inputClass} mt-1.5`}>
                      <option value="billing_period">Billing period</option><option value="monthly">Calendar month (UTC)</option><option value="daily">Daily (UTC)</option>
                    </select>
                  </label>
                  <label className="text-xs text-gray-400">Enforcement
                    <select value={blockingSupported ? budget.enforcementMode : 'alert'} disabled={!blockingSupported} onChange={event => setBudget(current => ({ ...current, enforcementMode: event.target.value as BudgetFormState['enforcementMode'] }))} className={`${inputClass} mt-1.5 disabled:opacity-60`}>
                      <option value="alert">Alerts only</option><option value="soft_block">Soft block</option><option value="hard_block">Hard block</option>
                    </select>
                  </label>
                  <label className="text-xs text-gray-400">Soft usage limit
                    <input value={budget.softLimitQuantity} onChange={event => setBudget(current => ({ ...current, softLimitQuantity: event.target.value }))} inputMode="decimal" className={`${inputClass} mt-1.5`} placeholder="e.g. 3000" />
                  </label>
                  {blockingSupported && <label className="text-xs text-gray-400">Hard usage limit
                    <input value={budget.hardLimitQuantity} onChange={event => setBudget(current => ({ ...current, hardLimitQuantity: event.target.value }))} inputMode="decimal" className={`${inputClass} mt-1.5`} placeholder="e.g. 5000" />
                  </label>}
                  <label className="text-xs text-gray-400">Soft spend alert ({budget.currency})
                    <input value={budget.softLimitAmount} onChange={event => setBudget(current => ({ ...current, softLimitAmount: event.target.value }))} inputMode="decimal" className={`${inputClass} mt-1.5`} placeholder="e.g. 500" />
                  </label>
                  {blockingSupported && <label className="text-xs text-gray-400">Hard spend limit ({budget.currency})
                    <input value={budget.hardLimitAmount} onChange={event => setBudget(current => ({ ...current, hardLimitAmount: event.target.value }))} inputMode="decimal" className={`${inputClass} mt-1.5`} placeholder="e.g. 750" />
                  </label>}
                </div>
                {!blockingSupported && <p className="mt-3 text-xs text-amber-300">This provider reports the metric after a call, so it supports threshold alerts only. Voice-time limits remain the pre-call spend guard.</p>}
                <button type="submit" disabled={busyAction !== null} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                  {busyAction === 'budget' && <Loader2 className="h-4 w-4 animate-spin" />} Save budget
                </button>
              </form>
            )}
          </div>
        </>
      )}
    </div>
  );
}
