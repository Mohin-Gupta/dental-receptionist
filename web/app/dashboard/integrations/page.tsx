'use client';

import axios from 'axios';
import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  Loader2,
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

const inputClass =
  'w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500';

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
  if (status === 'active') return 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300';
  if (status === 'provisioning') return 'border-amber-500/20 bg-amber-500/10 text-amber-300';
  return 'border-gray-700 bg-gray-800 text-gray-400';
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
      <div className="p-8">
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-8 text-center">
          <ShieldCheck className="mx-auto h-8 w-8 text-gray-600" />
          <h1 className="mt-3 text-lg font-semibold text-white">Integration owner access required</h1>
          <p className="mt-1 text-sm text-gray-500">Only an organization owner can manage provider credentials and resources.</p>
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
          <h1 className="text-2xl font-bold text-white">Provider integrations</h1>
          <p className="mt-1 text-sm text-gray-400">Platform-funded Vapi voice or tenant-owned provider accounts, with resources isolated to this organization.</p>
        </div>
        <button type="button" onClick={() => void load()} className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:bg-gray-800">
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      {notice && <div className="mb-5 flex items-start gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 text-sm text-emerald-200"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> {notice}</div>}
      {error && (
        <div className="mb-5 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">
          <div className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}</div>
          {needsMfa && <Link href="/mfa" className="mt-2 inline-block font-medium text-blue-300 hover:text-blue-200">Set up or verify MFA</Link>}
        </div>
      )}

      <section className="mb-5 rounded-xl border border-gray-800 bg-gray-900 p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-start gap-3">
            {health?.healthy ? <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-400" /> : <XCircle className="mt-0.5 h-5 w-5 text-amber-400" />}
            <div>
              <h2 className="font-semibold text-white">Configuration health</h2>
              <p className="mt-1 text-xs text-gray-500">Configuration and ownership state only; this is not a live provider uptime test.</p>
              {health?.organizationStatus && (
                <p className="mt-1 text-xs capitalize text-gray-500">Organization: {health.organizationStatus.replaceAll('_', ' ')}</p>
              )}
            </div>
          </div>
          <span className={`w-fit rounded-full border px-3 py-1 text-xs ${health?.healthy ? statusClass('active') : statusClass('provisioning')}`}>
            {health?.healthy ? 'Ready' : 'Action required'}
          </span>
        </div>
        {health && !health.healthy && (
          <div className="mt-4 grid gap-2 md:grid-cols-2">
            {[...health.accounts, ...health.resources].filter(item => item.issues.length > 0).map(item => (
              <div key={`${item.resourceType ?? 'account'}-${item.id}`} className="rounded-lg bg-gray-950/50 p-3">
                <p className="text-xs font-medium text-gray-300">{item.provider} {item.resourceType ? resourceLabel(item.resourceType) : 'account'}</p>
                <p className="mt-1 text-xs text-gray-500">{item.issues.join(' · ')}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mb-5 rounded-xl border border-gray-800 bg-gray-900 p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <CalendarDays className="mt-0.5 h-5 w-5 text-blue-400" />
            <div>
              <h2 className="font-semibold text-white">Google Calendar</h2>
              <p className="mt-1 text-xs text-gray-500">Connect the clinic calendar, then optionally isolate each doctor so simultaneous appointments remain available.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void connectCalendar('clinic')}
            disabled={busy !== null}
            className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy === 'calendar-clinic' ? 'Redirecting…' : calendarStatus?.clinicConnected ? 'Reconnect clinic calendar' : 'Connect clinic calendar'}
          </button>
        </div>
        {calendarStatus && (
          <div className="mt-4 divide-y divide-gray-800 rounded-lg border border-gray-800">
            {calendarStatus.doctors.map(doctor => (
              <div key={doctor.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm text-gray-200">{doctor.name}</p>
                  <p className="mt-0.5 text-xs text-gray-500">
                    {doctor.effectiveConnection === 'doctor'
                      ? 'Dedicated doctor calendar connected'
                      : doctor.effectiveConnection === 'clinic_fallback'
                        ? 'Using clinic calendar (shared availability)'
                        : 'No calendar available'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void connectCalendar('doctor', doctor.id)}
                  disabled={busy !== null}
                  className="rounded-lg border border-gray-700 px-3 py-2 text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-50"
                >
                  {busy === `calendar-${doctor.id}` ? 'Redirecting…' : doctor.directlyConnected ? 'Reconnect' : 'Connect doctor calendar'}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-5 xl:grid-cols-[1fr_0.9fr]">
        <div className="space-y-5">
          {accounts.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-700 bg-gray-900/50 p-10 text-center">
              <PlugZap className="mx-auto h-8 w-8 text-gray-600" />
              <p className="mt-3 text-sm text-gray-400">No provider account configured yet.</p>
            </div>
          ) : accounts.map(account => {
            const platformManaged = account.credentialSource === 'platform';
            const productionVapiStagingOnly =
              process.env.NODE_ENV === 'production' && account.provider === 'vapi' && !platformManaged;
            return (
            <section key={account.id} className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
              <div className="flex flex-col gap-4 border-b border-gray-800 p-5 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <ServerCog className="h-4 w-4 text-blue-400" />
                    <h2 className="font-semibold text-white">{providerTitle(account.provider)}</h2>
                    <span className={`rounded-full border px-2 py-0.5 text-[11px] capitalize ${statusClass(account.status)}`}>{account.status}</span>
                    {platformManaged && <span className="rounded-full border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-[11px] text-blue-300">Platform funded</span>}
                  </div>
                  {!platformManaged && <p className="mt-2 font-mono text-xs text-gray-500">{account.externalAccountId}</p>}
                  <p className="mt-1 text-xs text-gray-500">{platformManaged ? 'Credentials and resource assignments are controlled by the service operator.' : `Credentials: ${account.hasCredentials ? 'configured' : 'missing'}`}</p>
                </div>
                {!platformManaged && <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => setRotatingAccountId(account.id)} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-700 px-3 py-2 text-xs text-gray-300 hover:bg-gray-800"><KeyRound className="h-3.5 w-3.5" /> Rotate secret</button>
                  <button
                    type="button"
                    onClick={() => void updateAccountStatus(account, account.status === 'active' ? 'inactive' : 'active')}
                    disabled={busy !== null}
                    className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {busy === `account-${account.id}` ? 'Saving…' : account.status === 'active' ? 'Deactivate account' : 'Activate account'}
                  </button>
                </div>}
              </div>

              {!platformManaged && rotatingAccountId === account.id && (
                <form onSubmit={event => rotateCredentials(event, account)} className="border-b border-gray-800 bg-amber-500/5 p-4">
                  <label className="text-xs font-medium text-gray-400">New {account.provider === 'vapi' ? 'API key' : 'Auth Token'}
                    <input type="password" value={rotationSecret} onChange={event => setRotationSecret(event.target.value)} autoComplete="new-password" minLength={16} maxLength={512} className={`${inputClass} mt-1.5`} required />
                  </label>
                  <p className="mt-2 text-xs text-amber-300/80">The current secret is never returned. Saving replaces it after ownership checks pass.</p>
                  <div className="mt-3 flex gap-2">
                    <button type="submit" disabled={busy !== null} className="rounded-lg bg-amber-600 px-3 py-2 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50">Save rotated secret</button>
                    <button type="button" onClick={() => { setRotatingAccountId(null); setRotationSecret(''); }} className="rounded-lg border border-gray-700 px-3 py-2 text-xs text-gray-400">Cancel</button>
                  </div>
                </form>
              )}

              <div className="divide-y divide-gray-800">
                {account.resources.length === 0 ? (
                  <p className="p-5 text-sm text-gray-500">No external resources mapped to this account.</p>
                ) : account.resources.map(resource => {
                  const clinicName = organizationClinics.find(clinic => clinic.id === resource.clinicId)?.name ?? 'Organization-wide';
                  return (
                    <div key={resource.id} className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex items-start gap-3">
                        <Phone className="mt-0.5 h-4 w-4 text-gray-500" />
                        <div>
                          <div className="flex items-center gap-2"><p className="text-sm font-medium text-gray-200">{resource.displayName ?? resourceLabel(resource.resourceType)}</p><span className={`rounded-full border px-2 py-0.5 text-[11px] capitalize ${statusClass(resource.status)}`}>{resource.status}</span></div>
                          <p className="mt-1 font-mono text-xs text-gray-500">{resource.externalId}</p>
                          <p className="mt-1 text-xs text-gray-600">{resourceLabel(resource.resourceType)} · {clinicName}</p>
                        </div>
                      </div>
                      {platformManaged || productionVapiStagingOnly ? (
                        <span className="rounded-lg border border-gray-800 px-3 py-2 text-xs text-gray-500">
                          {platformManaged ? 'Operator managed' : 'Production staging only'}
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void (resource.status === 'active' ? deactivateResource(resource) : activateResource(resource))}
                          disabled={busy !== null}
                          className="rounded-lg border border-gray-700 px-3 py-2 text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-50"
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
          <form onSubmit={createAccount} className="rounded-xl border border-gray-800 bg-gray-900 p-5">
            <div className="flex items-center gap-2"><Plus className="h-4 w-4 text-blue-400" /><h2 className="font-semibold text-white">Add provider account</h2></div>
            <p className="mt-1 text-xs text-gray-500">Use this only for credentials your organization owns. Tenant-owned Vapi mappings are staging-only in production; production Vapi voice is provisioned by the service operator.</p>
            <div className="mt-4 space-y-3">
              <label className="block text-xs text-gray-400">Provider
                <select value={accountForm.provider} onChange={event => setAccountForm({ provider: event.target.value as IntegrationProvider, externalAccountId: '', secret: '' })} className={`${inputClass} mt-1.5`}>
                  <option value="vapi">Vapi</option><option value="twilio">Twilio</option>
                </select>
              </label>
              {accountForm.provider === 'twilio' && (
                <label className="block text-xs text-gray-400">Twilio Account SID
                  <input value={accountForm.externalAccountId} onChange={event => setAccountForm(current => ({ ...current, externalAccountId: event.target.value }))} placeholder="AC…" className={`${inputClass} mt-1.5 font-mono`} required />
                </label>
              )}
              <label className="block text-xs text-gray-400">{accountForm.provider === 'twilio' ? 'Twilio Auth Token' : 'Vapi API key'}
                <input type="password" value={accountForm.secret} onChange={event => setAccountForm(current => ({ ...current, secret: event.target.value }))} autoComplete="new-password" minLength={16} maxLength={512} className={`${inputClass} mt-1.5`} required />
              </label>
            </div>
            <button type="submit" disabled={busy !== null} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">{busy === 'create-account' && <Loader2 className="h-4 w-4 animate-spin" />} Save encrypted account</button>
          </form>

          <form onSubmit={createResource} className="rounded-xl border border-gray-800 bg-gray-900 p-5">
            <div className="flex items-center gap-2"><Plus className="h-4 w-4 text-blue-400" /><h2 className="font-semibold text-white">Map external resource</h2></div>
            <p className="mt-1 text-xs text-gray-500">The API verifies the resource is owned by the selected account before reserving it.</p>
            {tenantManagedAccounts.length === 0 ? (
              <p className="mt-4 rounded-lg bg-gray-950/50 p-3 text-xs text-gray-500">No tenant-managed provider account is available. Platform-funded Vapi resources are assigned by the service operator.</p>
            ) : (
              <div className="mt-4 space-y-3">
                <label className="block text-xs text-gray-400">Provider account
                  <select value={resourceForm.providerAccountId} onChange={event => selectResourceAccount(event.target.value)} className={`${inputClass} mt-1.5`} required>
                    {tenantManagedAccounts.map(account => <option key={account.id} value={account.id}>{providerTitle(account.provider)} · {account.externalAccountId}</option>)}
                  </select>
                </label>
                <label className="block text-xs text-gray-400">Resource type
                  <select value={resourceForm.resourceType} onChange={event => setResourceForm(current => ({ ...current, resourceType: event.target.value, externalId: '', inboundAssistantId: '' }))} className={`${inputClass} mt-1.5`}>
                    {selectedResourceAccount?.provider === 'vapi' ? <><option value="phone_number">Phone number ID</option><option value="assistant">Assistant ID</option></> : <><option value="phone_number">Phone number</option><option value="messaging_service">Messaging Service</option></>}
                  </select>
                </label>
                <label className="block text-xs text-gray-400">External identifier
                  <input value={resourceForm.externalId} onChange={event => setResourceForm(current => ({ ...current, externalId: event.target.value }))} placeholder={selectedResourceAccount?.provider === 'twilio' && resourceForm.resourceType === 'phone_number' ? '+14155552671' : resourceForm.resourceType === 'messaging_service' ? 'MG…' : 'Provider resource ID'} className={`${inputClass} mt-1.5 font-mono`} required />
                </label>
                <label className="block text-xs text-gray-400">Display name
                  <input value={resourceForm.displayName} onChange={event => setResourceForm(current => ({ ...current, displayName: event.target.value }))} placeholder="Main clinic line" maxLength={160} className={`${inputClass} mt-1.5`} />
                </label>
                <label className="block text-xs text-gray-400">Clinic assignment
                  <select value={resourceForm.clinicId} onChange={event => setResourceForm(current => ({ ...current, clinicId: event.target.value }))} className={`${inputClass} mt-1.5`} required={selectedResourceAccount?.provider === 'vapi' && resourceForm.resourceType === 'phone_number'}>
                    {!(selectedResourceAccount?.provider === 'vapi' && resourceForm.resourceType === 'phone_number') && <option value="">Organization-wide</option>}
                    {organizationClinics.map(clinic => <option key={clinic.id} value={clinic.id}>{clinic.name}</option>)}
                  </select>
                </label>
                {selectedResourceAccount?.provider === 'vapi' && resourceForm.resourceType === 'phone_number' && (
                  <label className="block text-xs text-gray-400">Inbound receptionist assistant
                    <select value={resourceForm.inboundAssistantId} onChange={event => setResourceForm(current => ({ ...current, inboundAssistantId: event.target.value }))} className={`${inputClass} mt-1.5`} required>
                      <option value="">Select an active assistant</option>
                      {availableInboundAssistants.map(resource => <option key={resource.id} value={resource.externalId}>{resource.displayName || resource.externalId}</option>)}
                    </select>
                    {availableInboundAssistants.length === 0 && <span className="mt-1 block text-amber-300">Create and activate the receptionist assistant first.</span>}
                  </label>
                )}
                <button type="submit" disabled={busy !== null || !selectedResourceAccount} className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">{busy === 'create-resource' && <Loader2 className="h-4 w-4 animate-spin" />} Verify and map resource</button>
              </div>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
