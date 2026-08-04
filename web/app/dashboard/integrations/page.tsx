'use client';

import axios from 'axios';
import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Bot,
  Cable,
  CheckCircle2,
  KeyRound,
  Loader2,
  MessageSquareText,
  Phone,
  PlugZap,
  Plus,
  RefreshCw,
  ServerCog,
  ShieldCheck,
  CalendarDays,
  XCircle,
} from 'lucide-react';
import api, {
  createIdempotencyKey,
  type IntegrationProvider,
  type IntegrationsHealthResponse,
  type IntegrationsResponse,
  type ProviderAccountView,
  type ProviderResourceView,
} from '@/lib/api';
import { useAuth } from '@/lib/auth';
import PageHeader from '@/components/ui/PageHeader';

const inputClass =
  'ui-input';
const selectClass = 'ui-select';

type CalendarStatus = {
  clinicId: string;
  clinicConnected: boolean;
  clinicConnectionUpdatedAt: string | null;
  doctors: Array<{
    id: string;
    name: string;
    directlyConnected: boolean;
    effectiveConnection: 'doctor' | 'clinic_fallback' | 'none';
    updatedAt: string | null;
  }>;
};

function requestError(error: unknown, fallback: string): { message: string; needsMfa: boolean } {
  if (!axios.isAxiosError(error)) return { message: fallback, needsMfa: false };
  return {
    message: error.response?.data?.error ?? fallback,
    needsMfa:
      error.response?.data?.mfaSetupRequired === true ||
      error.response?.data?.mfaRequired === true,
  };
}

function statusClass(status: string) {
  if (status === 'active') return 'status-pill status-success';
  if (status === 'provisioning') return 'status-pill status-warning';
  return 'status-pill status-neutral';
}

function providerTitle(provider: IntegrationProvider): string {
  return provider === 'vapi' ? 'Vapi voice' : 'Twilio messaging';
}

function resourceLabel(resourceType: string): string {
  if (resourceType === 'phone_number') return 'Phone number';
  if (resourceType === 'messaging_service') return 'Messaging Service';
  return 'Assistant';
}

export default function IntegrationsPage() {
  const {
    activeOrganizationId,
    activeClinicId,
    clinics,
    canManageIntegrations,
  } = useAuth();
  const [accounts, setAccounts] = useState<ProviderAccountView[]>([]);
  const [health, setHealth] = useState<IntegrationsHealthResponse | null>(null);
  const [calendarStatus, setCalendarStatus] = useState<CalendarStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [needsMfa, setNeedsMfa] = useState(false);
  const [accountForm, setAccountForm] = useState({
    provider: 'vapi' as IntegrationProvider,
    externalAccountId: '',
    secret: '',
  });
  const [resourceForm, setResourceForm] = useState({
    providerAccountId: '',
    resourceType: 'phone_number',
    externalId: '',
    displayName: '',
    clinicId: activeClinicId ?? '',
    inboundAssistantId: '',
  });
  const [rotatingAccountId, setRotatingAccountId] = useState<string | null>(null);
  const [rotationSecret, setRotationSecret] = useState('');

  const organizationClinics = useMemo(
    () => clinics.filter(clinic => clinic.organizationId === activeOrganizationId),
    [activeOrganizationId, clinics]
  );
  const tenantManagedAccounts = useMemo(
    () => accounts.filter(account => account.credentialSource !== 'platform'),
    [accounts]
  );
  const selectedResourceAccount = tenantManagedAccounts.find(
    account => account.id === resourceForm.providerAccountId
  );
  const availableInboundAssistants = selectedResourceAccount?.resources.filter(resource =>
    resource.provider === 'vapi' &&
    resource.resourceType === 'assistant' &&
    resource.status === 'active' &&
    (!resource.clinicId || resource.clinicId === resourceForm.clinicId)
  ) ?? [];

  const load = useCallback(async () => {
    if (!canManageIntegrations) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [accountsResponse, healthResponse, calendarResponse] = await Promise.all([
        api.get<IntegrationsResponse>('/dashboard/integrations'),
        api.get<IntegrationsHealthResponse>('/dashboard/integrations/health'),
        api.get<CalendarStatus>('/auth/google/status'),
      ]);
      setAccounts(accountsResponse.data.accounts);
      setHealth(healthResponse.data);
      setCalendarStatus(calendarResponse.data);
      setResourceForm(current => ({
        ...current,
        providerAccountId:
          accountsResponse.data.accounts.some(
            account => account.id === current.providerAccountId && account.credentialSource !== 'platform'
          )
            ? current.providerAccountId
            : accountsResponse.data.accounts.find(
                account => account.credentialSource !== 'platform'
              )?.id ?? '',
        clinicId: current.clinicId || activeClinicId || '',
      }));
    } catch (loadError) {
      setError(requestError(loadError, 'Unable to load provider integrations').message);
    } finally {
      setLoading(false);
    }
  }, [activeClinicId, canManageIntegrations]);

  useEffect(() => {
    void load();
  }, [activeOrganizationId, load]);

  const beginAction = (name: string) => {
    setBusy(name);
    setError('');
    setNotice('');
    setNeedsMfa(false);
  };

  const connectCalendar = async (scope: 'clinic' | 'doctor', doctorId?: string) => {
    beginAction(`calendar-${doctorId ?? 'clinic'}`);
    try {
      const response = await api.post<{ url: string }>('/auth/google/start', {
        scope,
        ...(doctorId ? { doctorId } : {}),
      });
      const destination = new URL(response.data.url);
      if (destination.protocol !== 'https:' || destination.hostname !== 'accounts.google.com') {
        throw new Error('Unexpected Google authorization destination');
      }
      window.location.assign(destination.toString());
    } catch (actionError) {
      failAction(actionError, 'Unable to start Google Calendar connection');
      setBusy(null);
    }
  };

  const failAction = (actionError: unknown, fallback: string) => {
    const detail = requestError(actionError, fallback);
    setError(detail.message);
    setNeedsMfa(detail.needsMfa);
  };

  const createAccount = async (event: FormEvent) => {
    event.preventDefault();
    beginAction('create-account');
    try {
      const credentials = accountForm.provider === 'vapi'
        ? { apiKey: accountForm.secret }
        : { accountSid: accountForm.externalAccountId, authToken: accountForm.secret };
      await api.post(
        '/dashboard/integrations/accounts',
        {
          provider: accountForm.provider,
          ...(accountForm.provider === 'twilio'
            ? { externalAccountId: accountForm.externalAccountId }
            : {}),
          credentials,
          status: 'provisioning',
          config: accountForm.provider === 'vapi' ? { environment: 'production' } : {},
        },
        { headers: { 'Idempotency-Key': createIdempotencyKey('provider-account') } }
      );
      setAccountForm(current => ({ ...current, externalAccountId: '', secret: '' }));
      setNotice('Provider account saved. Credentials were encrypted and will not be shown again.');
      await load();
    } catch (actionError) {
      failAction(actionError, 'Unable to create provider account');
    } finally {
      setBusy(null);
    }
  };

  const updateAccountStatus = async (account: ProviderAccountView, status: 'active' | 'inactive') => {
    beginAction(`account-${account.id}`);
    try {
      await api.patch(
        `/dashboard/integrations/accounts/${account.id}`,
        { status },
        { headers: { 'Idempotency-Key': createIdempotencyKey('provider-account-status') } }
      );
      setNotice(`${providerTitle(account.provider)} account ${status === 'active' ? 'activated' : 'deactivated'}.`);
      await load();
    } catch (actionError) {
      failAction(actionError, `Unable to ${status === 'active' ? 'activate' : 'deactivate'} provider account`);
    } finally {
      setBusy(null);
    }
  };

  const rotateCredentials = async (event: FormEvent, account: ProviderAccountView) => {
    event.preventDefault();
    beginAction(`rotate-${account.id}`);
    try {
      const credentials = account.provider === 'vapi'
        ? { apiKey: rotationSecret }
        : { accountSid: account.externalAccountId, authToken: rotationSecret };
      await api.post(
        `/dashboard/integrations/accounts/${account.id}/credentials/rotate`,
        { credentials },
        { headers: { 'Idempotency-Key': createIdempotencyKey('provider-credential-rotation') } }
      );
      setRotationSecret('');
      setRotatingAccountId(null);
      setNotice('Credentials rotated. The previous secret is no longer used by this workspace.');
      await load();
    } catch (actionError) {
      failAction(actionError, 'Unable to rotate provider credentials');
    } finally {
      setBusy(null);
    }
  };

  const selectResourceAccount = (providerAccountId: string) => {
    setResourceForm(current => ({
      ...current,
      providerAccountId,
      resourceType: 'phone_number',
      externalId: '',
      clinicId: activeClinicId ?? '',
      inboundAssistantId: '',
    }));
  };

  const createResource = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedResourceAccount) return;
    beginAction('create-resource');
    try {
      const clinicRequired = selectedResourceAccount.provider === 'vapi' && resourceForm.resourceType === 'phone_number';
      const config = selectedResourceAccount.provider === 'vapi'
        ? resourceForm.resourceType === 'assistant'
          ? { purpose: 'receptionist' }
          : { direction: 'both', inboundAssistantId: resourceForm.inboundAssistantId }
        : {};
      await api.post(
        '/dashboard/integrations/resources',
        {
          providerAccountId: selectedResourceAccount.id,
          provider: selectedResourceAccount.provider,
          resourceType: resourceForm.resourceType,
          externalId: resourceForm.externalId,
          displayName: resourceForm.displayName || null,
          clinicId: clinicRequired
            ? resourceForm.clinicId
            : resourceForm.clinicId || null,
          status: 'provisioning',
          config,
        },
        { headers: { 'Idempotency-Key': createIdempotencyKey('provider-resource') } }
      );
      setResourceForm(current => ({ ...current, externalId: '', displayName: '', inboundAssistantId: '' }));
      setNotice('External resource ownership verified and mapping created. Activate it when ready.');
      await load();
    } catch (actionError) {
      failAction(actionError, 'Unable to create provider resource');
    } finally {
      setBusy(null);
    }
  };

  const activateResource = async (resource: ProviderResourceView) => {
    beginAction(`resource-${resource.id}`);
    try {
      await api.patch(
        `/dashboard/integrations/resources/${resource.id}`,
        { status: 'active' },
        { headers: { 'Idempotency-Key': createIdempotencyKey('provider-resource-activation') } }
      );
      setNotice(`${resourceLabel(resource.resourceType)} activated.`);
      await load();
    } catch (actionError) {
      failAction(actionError, 'Unable to activate provider resource');
    } finally {
      setBusy(null);
    }
  };

  const deactivateResource = async (resource: ProviderResourceView) => {
    beginAction(`resource-${resource.id}`);
    try {
      await api.post(
        `/dashboard/integrations/resources/${resource.id}/deactivate`,
        {},
        { headers: { 'Idempotency-Key': createIdempotencyKey('provider-resource-deactivation') } }
      );
      setNotice(`${resourceLabel(resource.resourceType)} deactivated.`);
      await load();
    } catch (actionError) {
      failAction(actionError, 'Unable to deactivate provider resource');
    } finally {
      setBusy(null);
    }
  };

  if (!canManageIntegrations) {
    return (
      <div className="page-shell flex min-h-[70dvh] items-center justify-center">
        <div className="surface-card w-full max-w-lg px-6 py-12 text-center sm:px-10">
          <span className="empty-illustration"><ShieldCheck className="h-5 w-5" /></span>
          <p className="page-eyebrow mt-5 justify-center">Protected workspace</p>
          <h1 className="page-title text-[1.8rem]">Integration owner access required</h1>
          <p className="page-description mx-auto">Only an organization owner can manage provider credentials and external resources.</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="page-shell" role="status" aria-busy="true" aria-label="Loading provider integrations">
        <div className="mb-8 space-y-3"><div className="skeleton h-3 w-32" /><div className="skeleton h-10 w-72" /><div className="skeleton h-4 w-full max-w-2xl" /></div>
        <div className="skeleton h-52 w-full rounded-[1.35rem]" />
        <div className="mt-5 grid gap-5 xl:grid-cols-2"><div className="skeleton h-72" /><div className="skeleton h-72" /></div>
      </div>
    );
  }

  return (
    <div className="page-shell">
      <PageHeader
        eyebrow="Connected workspace"
        title="Provider integrations"
        description="Securely coordinate voice, messaging, and calendar services across your clinic organization."
        icon={PlugZap}
        actions={(
          <button type="button" onClick={() => void load()} className="btn-secondary">
            <RefreshCw className="h-4 w-4" /> Refresh status
          </button>
        )}
      />

      {notice && <div className="alert-success mb-5" role="status" aria-live="polite"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> <span>{notice}</span></div>}
      {error && (
        <div className="alert-error mb-5" role="alert">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0">
            <p>{error}</p>
            {needsMfa && <Link href="/mfa" className="mt-2 inline-flex font-bold text-danger underline decoration-danger/30 underline-offset-4 hover:decoration-danger">Set up or verify MFA</Link>}
          </div>
        </div>
      )}

      <section className="relative mb-5 overflow-hidden rounded-[1.35rem] border border-[#28483e] bg-nav p-5 text-white shadow-[0_18px_45px_rgba(18,39,32,0.15)] sm:p-7">
        <div className="pointer-events-none absolute -right-16 -top-24 h-72 w-72 rounded-full border border-white/[0.07]" />
        <div className="relative grid gap-7 lg:grid-cols-[1.3fr_0.7fr] lg:items-center">
          <div className="flex items-start gap-4">
            <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] border ${health?.healthy ? 'border-[#6caf9a]/35 bg-[#235044] text-[#8fd1bd]' : 'border-[#ad8a4d]/35 bg-[#564523] text-[#e0c27d]'}`}>
              {health?.healthy ? <CheckCircle2 className="h-5 w-5" /> : <XCircle className="h-5 w-5" />}
            </span>
            <div>
              <p className="text-[0.66rem] font-bold uppercase tracking-[0.15em] text-[#8eada2]">Configuration health</p>
              <h2 className="font-display mt-2 text-3xl font-medium tracking-[-0.04em] text-white">
                {health?.healthy ? 'Your service stack is ready.' : 'A few connections need attention.'}
              </h2>
              <p className="mt-2 max-w-2xl text-xs leading-5 text-[#9bb5ac]">This reflects configuration and resource ownership—not live provider uptime.</p>
              {health?.organizationStatus && (
                <p className="mt-3 text-xs capitalize text-[#c7d8d2]">Organization access: <span className="font-semibold">{health.organizationStatus.replaceAll('_', ' ')}</span></p>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-2xl border border-white/[0.1] bg-white/[0.06] p-4">
              <Activity className="h-4 w-4 text-[#8fc7b6]" />
              <p className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-white">{accounts.length}</p>
              <p className="mt-1 text-[0.66rem] font-medium text-[#91ada4]">Provider accounts</p>
            </div>
            <div className="rounded-2xl border border-white/[0.1] bg-white/[0.06] p-4">
              <Cable className="h-4 w-4 text-[#8fc7b6]" />
              <p className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-white">{accounts.reduce((total, account) => total + account.resources.length, 0)}</p>
              <p className="mt-1 text-[0.66rem] font-medium text-[#91ada4]">Mapped resources</p>
            </div>
          </div>
        </div>
        {health && !health.healthy && (
          <div className="relative mt-6 grid gap-2 border-t border-white/[0.09] pt-5 md:grid-cols-2">
            {[...health.accounts, ...health.resources].filter(item => item.issues.length > 0).map(item => (
              <div key={`${item.resourceType ?? 'account'}-${item.id}`} className="rounded-xl border border-[#a27f42]/25 bg-[#5a4826]/20 p-3">
                <p className="text-xs font-semibold capitalize text-[#ecd9ad]">{item.provider} {item.resourceType ? resourceLabel(item.resourceType) : 'account'}</p>
                <p className="mt-1 text-xs leading-5 text-[#c9b989]">{item.issues.join(' · ')}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="surface-card mb-5 overflow-hidden">
        <div className="surface-header flex-col sm:flex-row sm:items-start">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#d3e6df] bg-brand-softer text-brand"><CalendarDays className="h-4 w-4" /></span>
            <div>
              <p className="section-kicker mb-1">Scheduling backbone</p>
              <h2 className="section-title">Google Calendar</h2>
              <p className="section-description">Connect the clinic calendar, then optionally give each doctor dedicated availability.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void connectCalendar('clinic')}
            disabled={busy !== null}
            className="btn-primary w-full sm:w-auto"
          >
            {busy === 'calendar-clinic' ? 'Redirecting…' : calendarStatus?.clinicConnected ? 'Reconnect clinic calendar' : 'Connect clinic calendar'}
          </button>
        </div>
        {calendarStatus && (
          <div className="divide-y divide-line">
            {calendarStatus.doctors.map(doctor => (
              <div key={doctor.id} className="flex flex-col gap-3 px-4 py-4 transition-colors hover:bg-surface-subtle sm:flex-row sm:items-center sm:justify-between sm:px-5">
                <div className="flex items-center gap-3">
                  <span className="avatar h-9 w-9 text-xs">{doctor.name.charAt(0).toUpperCase()}</span>
                  <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2"><p className="text-sm font-semibold text-ink">{doctor.name}</p><span className={`status-pill ${doctor.effectiveConnection === 'none' ? 'status-warning' : 'status-success'}`}>{doctor.effectiveConnection === 'doctor' ? 'Dedicated' : doctor.effectiveConnection === 'clinic_fallback' ? 'Clinic fallback' : 'Not connected'}</span></div>
                  <p className="mt-1 text-xs text-muted">
                    {doctor.effectiveConnection === 'doctor'
                      ? 'Dedicated doctor calendar connected'
                      : doctor.effectiveConnection === 'clinic_fallback'
                        ? 'Using clinic calendar (shared availability)'
                        : 'No calendar available'}
                  </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void connectCalendar('doctor', doctor.id)}
                  disabled={busy !== null}
                  className="btn-secondary w-full sm:w-auto"
                >
                  {busy === `calendar-${doctor.id}` ? 'Redirecting…' : doctor.directlyConnected ? 'Reconnect' : 'Connect doctor calendar'}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="grid items-start gap-5 xl:grid-cols-[1.08fr_0.92fr]">
        <div className="space-y-5">
          {accounts.length === 0 ? (
            <div className="surface-card border-dashed px-6 py-14 text-center">
              <span className="empty-illustration"><PlugZap className="h-5 w-5" /></span>
              <p className="mt-4 text-sm font-semibold text-ink">No provider account configured</p>
              <p className="mt-1 text-xs text-muted">Add an organization-owned account to begin mapping resources.</p>
            </div>
          ) : accounts.map(account => {
            const platformManaged = account.credentialSource === 'platform';
            const productionVapiStagingOnly =
              process.env.NODE_ENV === 'production' && account.provider === 'vapi' && !platformManaged;
            return (
            <section key={account.id} className="surface-card overflow-hidden">
              <div className="flex flex-col gap-4 border-b border-line p-4 sm:flex-row sm:items-start sm:justify-between sm:p-5">
                <div className="flex items-start gap-3">
                  <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[13px] text-sm font-extrabold ${account.provider === 'vapi' ? 'bg-[#ece8fa] text-[#6754a8]' : 'bg-[#fcebea] text-[#ba3c36]'}`} aria-hidden="true">
                    {account.provider === 'vapi' ? 'V' : 'T'}
                  </span>
                  <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-bold text-ink">{providerTitle(account.provider)}</h2>
                    <span className={statusClass(account.status)}>{account.status}</span>
                    {platformManaged && <span className="status-pill status-info">Platform funded</span>}
                  </div>
                  {!platformManaged && <p className="mt-2 max-w-[18rem] truncate font-mono text-[0.7rem] text-muted" title={account.externalAccountId}>{account.externalAccountId}</p>}
                  <p className="mt-1 text-xs leading-5 text-muted">{platformManaged ? 'Credentials and resource assignments are controlled by the service operator.' : `Credentials: ${account.hasCredentials ? 'configured' : 'missing'}`}</p>
                  </div>
                </div>
                {!platformManaged && <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => setRotatingAccountId(account.id)} className="btn-secondary"><KeyRound className="h-3.5 w-3.5" /> Rotate secret</button>
                  <button
                    type="button"
                    onClick={() => void updateAccountStatus(account, account.status === 'active' ? 'inactive' : 'active')}
                    disabled={busy !== null}
                    className={account.status === 'active' ? 'btn-danger-soft' : 'btn-primary'}
                  >
                    {busy === `account-${account.id}` ? 'Saving…' : account.status === 'active' ? 'Deactivate account' : 'Activate account'}
                  </button>
                </div>}
              </div>

              {!platformManaged && rotatingAccountId === account.id && (
                <form onSubmit={event => rotateCredentials(event, account)} className="border-b border-[#ead9b6] bg-warning-soft p-4 sm:p-5">
                  <label className="ui-label">New {account.provider === 'vapi' ? 'API key' : 'Auth Token'}
                    <input type="password" value={rotationSecret} onChange={event => setRotationSecret(event.target.value)} autoComplete="new-password" minLength={16} maxLength={512} className={`${inputClass} mt-1.5`} required />
                  </label>
                  <p className="mt-2 text-xs leading-5 text-warning">The current secret is never returned. Saving replaces it after ownership checks pass.</p>
                  <div className="mt-3 flex gap-2">
                    <button type="submit" disabled={busy !== null} className="btn-primary">Save rotated secret</button>
                    <button type="button" onClick={() => { setRotatingAccountId(null); setRotationSecret(''); }} className="btn-secondary">Cancel</button>
                  </div>
                </form>
              )}

              <div className="divide-y divide-line">
                {account.resources.length === 0 ? (
                  <p className="p-5 text-sm text-muted">No external resources mapped to this account.</p>
                ) : account.resources.map(resource => {
                  const clinicName = organizationClinics.find(clinic => clinic.id === resource.clinicId)?.name ?? 'Organization-wide';
                  const ResourceIcon = resource.resourceType === 'assistant' ? Bot : resource.resourceType === 'messaging_service' ? MessageSquareText : Phone;
                  return (
                    <div key={resource.id} className="flex flex-col gap-3 p-4 transition-colors hover:bg-surface-subtle sm:flex-row sm:items-center sm:justify-between sm:p-5">
                      <div className="flex items-start gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-line bg-surface-subtle text-muted"><ResourceIcon className="h-4 w-4" /></span>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2"><p className="text-sm font-semibold text-ink">{resource.displayName ?? resourceLabel(resource.resourceType)}</p><span className={statusClass(resource.status)}>{resource.status}</span></div>
                          <p className="mt-1 break-all font-mono text-[0.7rem] text-muted">{resource.externalId}</p>
                          <p className="mt-1 text-[0.7rem] text-muted">{resourceLabel(resource.resourceType)} · {clinicName}</p>
                        </div>
                      </div>
                      {platformManaged || productionVapiStagingOnly ? (
                        <span className="status-pill status-neutral">
                          {platformManaged ? 'Operator managed' : 'Production staging only'}
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void (resource.status === 'active' ? deactivateResource(resource) : activateResource(resource))}
                          disabled={busy !== null}
                          className={resource.status === 'active' ? 'btn-danger-soft' : 'btn-secondary'}
                        >
                          {busy === `resource-${resource.id}` ? 'Saving…' : resource.status === 'active' ? 'Deactivate' : 'Activate'}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
            );
          })}
        </div>

        <div className="space-y-5">
          <form onSubmit={createAccount} className="surface-card overflow-hidden">
            <div className="surface-header">
              <div className="flex items-start gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#d3e6df] bg-brand-softer text-brand"><ServerCog className="h-4 w-4" /></span><div><p className="section-kicker mb-1">Credentials</p><h2 className="section-title">Add provider account</h2><p className="section-description">For credentials owned by your organization.</p></div></div>
            </div>
            <div className="space-y-4 p-4 sm:p-5">
              <div className="alert-info"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" /><span>Tenant-owned Vapi mappings are staging-only in production; live Vapi voice is provisioned by the service operator.</span></div>
              <label className="ui-label">Provider
                <select value={accountForm.provider} onChange={event => setAccountForm({ provider: event.target.value as IntegrationProvider, externalAccountId: '', secret: '' })} className={`${selectClass} mt-1.5`}>
                  <option value="vapi">Vapi</option><option value="twilio">Twilio</option>
                </select>
              </label>
              {accountForm.provider === 'twilio' && (
                <label className="ui-label">Twilio Account SID
                  <input value={accountForm.externalAccountId} onChange={event => setAccountForm(current => ({ ...current, externalAccountId: event.target.value }))} placeholder="AC…" className={`${inputClass} mt-1.5 font-mono`} required />
                </label>
              )}
              <label className="ui-label">{accountForm.provider === 'twilio' ? 'Twilio Auth Token' : 'Vapi API key'}
                <input type="password" value={accountForm.secret} onChange={event => setAccountForm(current => ({ ...current, secret: event.target.value }))} autoComplete="new-password" minLength={16} maxLength={512} className={`${inputClass} mt-1.5`} required />
              </label>
              <button type="submit" disabled={busy !== null} className="btn-primary w-full">{busy === 'create-account' && <Loader2 className="h-4 w-4 animate-spin" />} Save encrypted account</button>
            </div>
          </form>

          <form onSubmit={createResource} className="surface-card overflow-hidden">
            <div className="surface-header">
              <div className="flex items-start gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#d3e6df] bg-brand-softer text-brand"><Plus className="h-4 w-4" /></span><div><p className="section-kicker mb-1">Resource mapping</p><h2 className="section-title">Map external resource</h2><p className="section-description">Ownership is verified before the resource is reserved.</p></div></div>
            </div>
            {tenantManagedAccounts.length === 0 ? (
              <div className="p-4 sm:p-5"><div className="alert-info"><PlugZap className="mt-0.5 h-4 w-4 shrink-0" />No tenant-managed provider account is available. Platform-funded Vapi resources are assigned by the service operator.</div></div>
            ) : (
              <div className="space-y-4 p-4 sm:p-5">
                <label className="ui-label">Provider account
                  <select value={resourceForm.providerAccountId} onChange={event => selectResourceAccount(event.target.value)} className={`${selectClass} mt-1.5`} required>
                    {tenantManagedAccounts.map(account => <option key={account.id} value={account.id}>{providerTitle(account.provider)} · {account.externalAccountId}</option>)}
                  </select>
                </label>
                <label className="ui-label">Resource type
                  <select value={resourceForm.resourceType} onChange={event => setResourceForm(current => ({ ...current, resourceType: event.target.value, externalId: '', inboundAssistantId: '' }))} className={`${selectClass} mt-1.5`}>
                    {selectedResourceAccount?.provider === 'vapi' ? <><option value="phone_number">Phone number ID</option><option value="assistant">Assistant ID</option></> : <><option value="phone_number">Phone number</option><option value="messaging_service">Messaging Service</option></>}
                  </select>
                </label>
                <label className="ui-label">External identifier
                  <input value={resourceForm.externalId} onChange={event => setResourceForm(current => ({ ...current, externalId: event.target.value }))} placeholder={selectedResourceAccount?.provider === 'twilio' && resourceForm.resourceType === 'phone_number' ? '+14155552671' : resourceForm.resourceType === 'messaging_service' ? 'MG…' : 'Provider resource ID'} className={`${inputClass} mt-1.5 font-mono`} required />
                </label>
                <label className="ui-label">Display name
                  <input value={resourceForm.displayName} onChange={event => setResourceForm(current => ({ ...current, displayName: event.target.value }))} placeholder="Main clinic line" maxLength={160} className={`${inputClass} mt-1.5`} />
                </label>
                <label className="ui-label">Clinic assignment
                  <select value={resourceForm.clinicId} onChange={event => setResourceForm(current => ({ ...current, clinicId: event.target.value }))} className={`${selectClass} mt-1.5`} required={selectedResourceAccount?.provider === 'vapi' && resourceForm.resourceType === 'phone_number'}>
                    {!(selectedResourceAccount?.provider === 'vapi' && resourceForm.resourceType === 'phone_number') && <option value="">Organization-wide</option>}
                    {organizationClinics.map(clinic => <option key={clinic.id} value={clinic.id}>{clinic.name}</option>)}
                  </select>
                </label>
                {selectedResourceAccount?.provider === 'vapi' && resourceForm.resourceType === 'phone_number' && (
                  <label className="ui-label">Inbound receptionist assistant
                    <select value={resourceForm.inboundAssistantId} onChange={event => setResourceForm(current => ({ ...current, inboundAssistantId: event.target.value }))} className={`${selectClass} mt-1.5`} required>
                      <option value="">Select an active assistant</option>
                      {availableInboundAssistants.map(resource => <option key={resource.id} value={resource.externalId}>{resource.displayName || resource.externalId}</option>)}
                    </select>
                    {availableInboundAssistants.length === 0 && <span className="mt-2 block text-xs font-medium text-warning">Create and activate the receptionist assistant first.</span>}
                  </label>
                )}
                <button type="submit" disabled={busy !== null || !selectedResourceAccount} className="btn-primary w-full">{busy === 'create-resource' && <Loader2 className="h-4 w-4 animate-spin" />} Verify and map resource</button>
              </div>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
