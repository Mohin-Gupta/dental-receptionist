'use client';

import axios from 'axios';
import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  Building2,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MailPlus,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserCog,
  UsersRound,
} from 'lucide-react';
import api, {
  createIdempotencyKey,
  type AuthRole,
  type BillingSummary,
} from '@/lib/api';
import { useAuth } from '@/lib/auth';

const inputClass =
  'w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500';
const PAGE_LIMIT = 25;
const CLINIC_NOTICE_KEY = 'organization-control-clinic-created';

const countryOptions = [
  { countryCode: 'IN', callingCode: '91', locale: 'en-IN', label: 'India (+91)' },
  { countryCode: 'US', callingCode: '1', locale: 'en-US', label: 'United States (+1)' },
  { countryCode: 'CA', callingCode: '1', locale: 'en-CA', label: 'Canada (+1)' },
  { countryCode: 'GB', callingCode: '44', locale: 'en-GB', label: 'United Kingdom (+44)' },
  { countryCode: 'AU', callingCode: '61', locale: 'en-AU', label: 'Australia (+61)' },
] as const;

interface ClinicAssignment {
  clinicId: string;
  role: AuthRole;
  clinic: { name: string };
}

interface OrganizationMember {
  id: string;
  name: string;
  email: string;
  status: string;
  mfaRequired: boolean;
  organizationRole: AuthRole | null;
  clinicAssignments: ClinicAssignment[];
}

interface PendingInvite {
  id: string;
  email: string;
  organizationRole: AuthRole | null;
  clinicRole: AuthRole | null;
  clinicId: string | null;
  expiresAt: string;
  createdAt: string;
}

interface MembersResponse {
  members: OrganizationMember[];
  pendingInvites: PendingInvite[];
  total: number;
  page: number;
  limit: number;
}

interface ManagedClinic {
  id: string;
  name: string;
  phone: string;
  timezone: string;
  countryCode: string;
  locale: string;
  status: 'active' | 'archived';
  archivedAt: string | null;
  createdAt: string;
  _count: { memberships: number; appointments: number };
}

interface ManagedClinicsResponse {
  clinics: ManagedClinic[];
}

interface MemberDraft {
  organizationRole: AuthRole | '';
  clinicRoles: Record<string, AuthRole | ''>;
}

interface MutationError {
  message: string;
  mfaAction: 'setup' | 'verify' | null;
  paymentRequired: boolean;
}

function requestError(error: unknown, fallback: string): MutationError {
  if (!axios.isAxiosError(error)) {
    return { message: fallback, mfaAction: null, paymentRequired: false };
  }
  return {
    message: error.response?.data?.error ?? fallback,
    mfaAction: error.response?.data?.mfaSetupRequired === true
      ? 'setup'
      : error.response?.data?.mfaRequired === true
        ? 'verify'
        : null,
    paymentRequired: error.response?.status === 402,
  };
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function roleLabel(role: AuthRole | null): string {
  return role ? role[0].toUpperCase() + role.slice(1) : 'No organization role';
}

function memberDraft(member: OrganizationMember): MemberDraft {
  return {
    organizationRole: member.organizationRole ?? '',
    clinicRoles: Object.fromEntries(
      member.clinicAssignments.map(assignment => [assignment.clinicId, assignment.role])
    ),
  };
}

export default function OrganizationPage() {
  const {
    user,
    organizationRole,
    activeOrganizationId,
    activeClinicId,
    clinics,
    refresh: refreshAuth,
    setScope,
  } = useAuth();
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [managedClinics, setManagedClinics] = useState<ManagedClinic[]>([]);
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [drafts, setDrafts] = useState<Record<string, MemberDraft>>({});
  const [billing, setBilling] = useState<BillingSummary | null>(null);
  const [billingLoadError, setBillingLoadError] = useState('');
  const [entitlementEvaluationTime, setEntitlementEvaluationTime] = useState(0);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [mfaAction, setMfaAction] = useState<'setup' | 'verify' | null>(null);
  const [paymentRequired, setPaymentRequired] = useState(false);
  const [invite, setInvite] = useState({
    email: '',
    scope: 'clinic' as 'organization' | 'clinic',
    organizationRole: 'viewer' as 'admin' | 'viewer',
    clinicRole: 'staff' as 'admin' | 'staff' | 'viewer',
    clinicId: '',
  });
  const [clinic, setClinic] = useState({
    name: '',
    phone: '',
    timezone: 'Asia/Kolkata',
    countryCode: 'IN',
    defaultCallingCode: '91',
    locale: 'en-IN',
  });

  const organizationClinics = useMemo(
    () => clinics.filter(item => item.organizationId === activeOrganizationId),
    [activeOrganizationId, clinics]
  );

  const load = useCallback(async () => {
    if (organizationRole !== 'owner') {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const [membersResult, billingResult, clinicsResult] = await Promise.allSettled([
        api.get<MembersResponse>('/dashboard/organization/members', {
          params: { page, limit: PAGE_LIMIT },
        }),
        api.get<BillingSummary>('/billing/summary'),
        api.get<ManagedClinicsResponse>('/dashboard/organization/clinics'),
      ]);
      if (membersResult.status === 'rejected') throw membersResult.reason;
      if (clinicsResult.status === 'rejected') throw clinicsResult.reason;
      const membersResponse = membersResult.value;
      setMembers(membersResponse.data.members);
      setPendingInvites(membersResponse.data.pendingInvites);
      setManagedClinics(clinicsResult.value.data.clinics);
      setTotal(membersResponse.data.total);
      setDrafts(Object.fromEntries(
        membersResponse.data.members.map(member => [member.id, memberDraft(member)])
      ));
      if (billingResult.status === 'fulfilled') {
        setBilling(billingResult.value.data);
        setEntitlementEvaluationTime(Date.now());
        setBillingLoadError('');
      } else {
        setBilling(null);
        setBillingLoadError('Clinic subscription capacity could not be loaded. Member administration remains available.');
      }
    } catch (loadError) {
      setError(requestError(loadError, 'Unable to load organization administration').message);
    } finally {
      setLoading(false);
    }
  }, [organizationRole, page]);

  useEffect(() => {
    void load();
  }, [activeOrganizationId, load]);

  useEffect(() => {
    const detectedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (detectedTimezone) {
      setClinic(current => ({ ...current, timezone: detectedTimezone }));
    }
    if (sessionStorage.getItem(CLINIC_NOTICE_KEY) === 'true') {
      sessionStorage.removeItem(CLINIC_NOTICE_KEY);
      setNotice('Clinic created and added to the location selector.');
    }
  }, []);

  useEffect(() => {
    if (!invite.clinicId && organizationClinics[0]) {
      setInvite(current => ({ ...current, clinicId: organizationClinics[0].id }));
    }
  }, [invite.clinicId, organizationClinics]);

  const beginAction = (action: string) => {
    setBusy(action);
    setError('');
    setNotice('');
    setMfaAction(null);
    setPaymentRequired(false);
  };

  const failAction = (actionError: unknown, fallback: string) => {
    const detail = requestError(actionError, fallback);
    setError(detail.message);
    setMfaAction(detail.mfaAction);
    setPaymentRequired(detail.paymentRequired);
  };

  const sendInvite = async (event: FormEvent) => {
    event.preventDefault();
    if (invite.scope === 'clinic' && !invite.clinicId) {
      setError('Select a clinic for this invitation');
      return;
    }
    beginAction('invite');
    try {
      const payload = invite.scope === 'organization'
        ? { email: invite.email, organizationRole: invite.organizationRole }
        : { email: invite.email, clinicRole: invite.clinicRole, clinicId: invite.clinicId };
      await api.post('/auth/invites', payload, {
        headers: { 'Idempotency-Key': createIdempotencyKey('organization-invite') },
      });
      setInvite(current => ({ ...current, email: '' }));
      setNotice('Invitation sent. The recipient must authenticate before access is granted.');
      await load();
    } catch (actionError) {
      failAction(actionError, 'Unable to send invitation');
    } finally {
      setBusy(null);
    }
  };

  const cancelInvite = async (pending: PendingInvite) => {
    if (!window.confirm(`Cancel the pending invitation for ${pending.email}?`)) return;
    beginAction(`invite-${pending.id}`);
    try {
      await api.delete(`/dashboard/organization/invites/${pending.id}`, {
        headers: { 'Idempotency-Key': createIdempotencyKey('organization-invite-cancel') },
      });
      setNotice(`Invitation for ${pending.email} cancelled.`);
      await load();
    } catch (actionError) {
      failAction(actionError, 'Unable to cancel invitation');
    } finally {
      setBusy(null);
    }
  };

  const updateDraftOrganizationRole = (memberId: string, role: AuthRole | '') => {
    setDrafts(current => ({
      ...current,
      [memberId]: { ...current[memberId], organizationRole: role },
    }));
  };

  const updateDraftClinicRole = (memberId: string, clinicId: string, role: AuthRole | '') => {
    setDrafts(current => ({
      ...current,
      [memberId]: {
        ...current[memberId],
        clinicRoles: { ...current[memberId]?.clinicRoles, [clinicId]: role },
      },
    }));
  };

  const saveMember = async (member: OrganizationMember) => {
    const draft = drafts[member.id];
    if (!draft || member.id === user?.id) return;

    const nextOrganizationRole = draft.organizationRole || null;
    const originalClinicRoles = new Map(
      member.clinicAssignments.map(assignment => [assignment.clinicId, assignment.role])
    );
    const clinicIds = new Set([
      ...originalClinicRoles.keys(),
      ...Object.keys(draft.clinicRoles),
    ]);
    const clinicAssignments = [...clinicIds]
      .map(clinicId => ({
        clinicId,
        role: draft.clinicRoles[clinicId] || null,
      }))
      .filter(assignment => assignment.role !== (originalClinicRoles.get(assignment.clinicId) ?? null));
    const organizationChanged = nextOrganizationRole !== member.organizationRole;

    if (!organizationChanged && clinicAssignments.length === 0) {
      setNotice(`No access changes to save for ${member.name}.`);
      return;
    }
    const hasAccess = nextOrganizationRole !== null || Object.values(draft.clinicRoles).some(Boolean);
    if (!hasAccess) {
      setError('Use “Remove tenant access” for an explicit, confirmed removal.');
      return;
    }
    const grantsOwnership =
      (member.organizationRole !== 'owner' && nextOrganizationRole === 'owner') ||
      clinicAssignments.some(assignment => assignment.role === 'owner');
    const removesOwnership =
      (member.organizationRole === 'owner' && nextOrganizationRole !== 'owner') ||
      clinicAssignments.some(assignment => (
        originalClinicRoles.get(assignment.clinicId) === 'owner' && assignment.role !== 'owner'
      ));
    if (
      (grantsOwnership || removesOwnership) &&
      !window.confirm(
        grantsOwnership
          ? `Grant owner privileges to ${member.email}? Owners can administer sensitive tenant settings.`
          : `Remove organization-owner privileges from ${member.email}? The organization must retain another owner.`
      )
    ) {
      return;
    }

    beginAction(`member-${member.id}`);
    try {
      const payload: {
        organizationRole?: AuthRole | null;
        clinicAssignments?: Array<{ clinicId: string; role: AuthRole | null }>;
      } = {};
      if (organizationChanged) payload.organizationRole = nextOrganizationRole;
      if (clinicAssignments.length > 0) payload.clinicAssignments = clinicAssignments;
      await api.patch(`/dashboard/organization/members/${member.id}`, payload, {
        headers: { 'Idempotency-Key': createIdempotencyKey('organization-member-update') },
      });
      setNotice(`Access updated for ${member.name}.`);
      await load();
    } catch (actionError) {
      failAction(actionError, 'Unable to update member access');
    } finally {
      setBusy(null);
    }
  };

  const removeMember = async (member: OrganizationMember) => {
    if (member.id === user?.id) return;
    if (!window.confirm(`Remove all access to this organization for ${member.email}?`)) return;
    beginAction(`remove-${member.id}`);
    try {
      await api.patch(
        `/dashboard/organization/members/${member.id}`,
        {
          organizationRole: null,
          clinicAssignments: member.clinicAssignments.map(assignment => ({
            clinicId: assignment.clinicId,
            role: null,
          })),
        },
        { headers: { 'Idempotency-Key': createIdempotencyKey('organization-member-removal') } }
      );
      setNotice(`Tenant access removed for ${member.email}.`);
      if (members.length === 1 && page > 1) {
        setPage(current => current - 1);
      } else {
        await load();
      }
    } catch (actionError) {
      failAction(actionError, 'Unable to remove member access');
    } finally {
      setBusy(null);
    }
  };

  const selectCountry = (countryCode: string) => {
    const selected = countryOptions.find(option => option.countryCode === countryCode);
    if (!selected) return;
    setClinic(current => ({
      ...current,
      countryCode: selected.countryCode,
      defaultCallingCode: selected.callingCode,
      locale: selected.locale,
    }));
  };

  const clinicEntitlement = billing?.entitlements.find(entitlement => (
    entitlement.key === 'clinics.max' &&
    entitlement.enabled &&
    new Date(entitlement.effectiveAt).getTime() <= entitlementEvaluationTime &&
    (!entitlement.expiresAt || new Date(entitlement.expiresAt).getTime() > entitlementEvaluationTime)
  ));
  const parsedClinicLimit = clinicEntitlement?.limit ? Number(clinicEntitlement.limit) : null;
  const clinicLimit = parsedClinicLimit !== null && Number.isFinite(parsedClinicLimit)
    ? Math.floor(parsedClinicLimit)
    : null;
  const activeForClinicCreation = billing
    ? ['active', 'past_due_grace'].includes(billing.organization.status)
    : false;
  const clinicLimitAvailable =
    clinicLimit !== null && Number.isFinite(clinicLimit) && organizationClinics.length < clinicLimit;
  const canCreateClinic = activeForClinicCreation && clinicLimitAvailable;

  const createClinic = async (event: FormEvent) => {
    event.preventDefault();
    if (!canCreateClinic) {
      setError('The current subscription does not have available clinic capacity.');
      setPaymentRequired(true);
      return;
    }
    beginAction('clinic');
    try {
      await api.post('/dashboard/organization/clinics', clinic, {
        headers: { 'Idempotency-Key': createIdempotencyKey('organization-clinic-create') },
      });
      sessionStorage.setItem(CLINIC_NOTICE_KEY, 'true');
      await refreshAuth();
    } catch (actionError) {
      failAction(actionError, 'Unable to create clinic');
    } finally {
      setBusy(null);
    }
  };

  const changeClinicStatus = async (clinicToChange: ManagedClinic) => {
    const nextStatus = clinicToChange.status === 'active' ? 'archived' : 'active';
    const warning = nextStatus === 'archived'
      ? `Archive ${clinicToChange.name}? It will stop receiving tenant traffic, and its provider resources will be disabled.`
      : `Restore ${clinicToChange.name}? Provider resources will stay disabled until you review them in Integrations.`;
    if (!window.confirm(warning)) return;
    beginAction(`clinic-status-${clinicToChange.id}`);
    try {
      await api.patch(
        `/dashboard/organization/clinics/${clinicToChange.id}/status`,
        { status: nextStatus },
        { headers: { 'Idempotency-Key': createIdempotencyKey('organization-clinic-status') } }
      );
      setNotice(
        nextStatus === 'archived'
          ? `${clinicToChange.name} archived.`
          : `${clinicToChange.name} restored. Review and reactivate its provider resources.`
      );
      if (nextStatus === 'archived' && clinicToChange.id === activeClinicId) {
        const fallback = organizationClinics.find(item => item.id !== clinicToChange.id);
        if (fallback && activeOrganizationId) {
          await setScope(activeOrganizationId, fallback.id);
          await load();
          return;
        }
      }
      await refreshAuth();
      await load();
    } catch (actionError) {
      failAction(actionError, 'Unable to update clinic status');
    } finally {
      setBusy(null);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_LIMIT));

  if (organizationRole !== 'owner') {
    return (
      <div className="p-8">
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-8 text-center">
          <ShieldAlert className="mx-auto h-8 w-8 text-gray-600" />
          <h1 className="mt-3 text-lg font-semibold text-white">Organization owner access required</h1>
          <p className="mt-1 text-sm text-gray-500">Only an organization owner can manage tenant members, invitations, and clinic locations.</p>
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
          <h1 className="text-2xl font-bold text-white">Organization</h1>
          <p className="mt-1 text-sm text-gray-400">Manage tenant access, pending invitations, and subscription-controlled locations.</p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={busy !== null}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:bg-gray-800 disabled:opacity-50"
        >
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      {notice && (
        <div className="mb-5 flex items-start gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 text-sm text-emerald-200">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> {notice}
        </div>
      )}
      {error && (
        <div className="mb-5 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300">
          <div className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}</div>
          {mfaAction && (
            <Link href="/mfa" className="mt-2 inline-block font-medium text-blue-300 hover:text-blue-200">
              {mfaAction === 'setup' ? 'Set up MFA' : 'Verify with MFA'}
            </Link>
          )}
          {paymentRequired && (
            <Link href="/dashboard/billing" className="mt-2 ml-4 inline-block font-medium text-blue-300 hover:text-blue-200">Review plan</Link>
          )}
        </div>
      )}

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
          <UsersRound className="h-5 w-5 text-blue-400" />
          <p className="mt-3 text-2xl font-semibold text-white">{total}</p>
          <p className="mt-1 text-xs text-gray-500">Members with tenant access</p>
        </section>
        <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
          <MailPlus className="h-5 w-5 text-blue-400" />
          <p className="mt-3 text-2xl font-semibold text-white">{pendingInvites.length}</p>
          <p className="mt-1 text-xs text-gray-500">Pending invitations</p>
        </section>
        <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
          <Building2 className="h-5 w-5 text-blue-400" />
          <p className="mt-3 text-2xl font-semibold text-white">
            {organizationClinics.length}{clinicLimit !== null ? ` / ${clinicLimit}` : ''}
          </p>
          <p className="mt-1 text-xs text-gray-500">Clinics used under clinics.max</p>
        </section>
      </div>

      <section className="mb-5 overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
        <div className="border-b border-gray-800 p-5">
          <h2 className="font-semibold text-white">Clinic lifecycle</h2>
          <p className="mt-1 text-xs text-gray-500">
            Archived clinics retain their records but cannot receive calls, messages, appointments, or member traffic.
          </p>
        </div>
        <div className="divide-y divide-gray-800">
          {managedClinics.map(item => (
            <div key={item.id} className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-gray-200">{item.name}</p>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] ${
                    item.status === 'active'
                      ? 'bg-emerald-500/10 text-emerald-300'
                      : 'bg-gray-800 text-gray-400'
                  }`}>
                    {item.status}
                  </span>
                  {item.id === activeClinicId && (
                    <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] text-blue-300">Selected</span>
                  )}
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  {item.phone} · {item.timezone} · {item._count.memberships} member assignment{item._count.memberships === 1 ? '' : 's'}
                  {item.status === 'active' && ` · ${item._count.appointments} future appointment${item._count.appointments === 1 ? '' : 's'}`}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void changeClinicStatus(item)}
                disabled={busy !== null}
                className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs disabled:opacity-50 ${
                  item.status === 'active'
                    ? 'border-amber-500/20 text-amber-300 hover:bg-amber-500/10'
                    : 'border-emerald-500/20 text-emerald-300 hover:bg-emerald-500/10'
                }`}
              >
                {busy === `clinic-status-${item.id}` ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : item.status === 'active' ? (
                  <Archive className="h-3.5 w-3.5" />
                ) : (
                  <RotateCcw className="h-3.5 w-3.5" />
                )}
                {item.status === 'active' ? 'Archive' : 'Restore'}
              </button>
            </div>
          ))}
        </div>
      </section>

      <div className="mb-5 grid gap-5 xl:grid-cols-2">
        <form onSubmit={sendInvite} className="rounded-xl border border-gray-800 bg-gray-900 p-5">
          <div className="flex items-center gap-2"><MailPlus className="h-4 w-4 text-blue-400" /><h2 className="font-semibold text-white">Invite a member</h2></div>
          <p className="mt-1 text-xs text-gray-500">Access is granted only after the recipient authenticates and accepts the invitation.</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-gray-400 sm:col-span-2">Email
              <input type="email" value={invite.email} onChange={event => setInvite(current => ({ ...current, email: event.target.value }))} autoComplete="email" className={`${inputClass} mt-1.5`} required />
            </label>
            <label className="text-xs text-gray-400">Access scope
              <select value={invite.scope} onChange={event => setInvite(current => ({ ...current, scope: event.target.value as 'organization' | 'clinic' }))} className={`${inputClass} mt-1.5`}>
                <option value="clinic">One clinic</option><option value="organization">Entire organization</option>
              </select>
            </label>
            {invite.scope === 'organization' ? (
              <label className="text-xs text-gray-400">Organization role
                <select value={invite.organizationRole} onChange={event => setInvite(current => ({ ...current, organizationRole: event.target.value as typeof current.organizationRole }))} className={`${inputClass} mt-1.5`}>
                  <option value="viewer">Viewer</option><option value="admin">Admin</option>
                </select>
                <span className="mt-1 block font-normal text-gray-600">Owner access can be granted after acceptance through an MFA-protected role change.</span>
              </label>
            ) : (
              <>
                <label className="text-xs text-gray-400">Clinic
                  <select value={invite.clinicId} onChange={event => setInvite(current => ({ ...current, clinicId: event.target.value }))} className={`${inputClass} mt-1.5`} required>
                    {organizationClinics.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                </label>
                <label className="text-xs text-gray-400 sm:col-span-2">Clinic role
                  <select value={invite.clinicRole} onChange={event => setInvite(current => ({ ...current, clinicRole: event.target.value as typeof current.clinicRole }))} className={`${inputClass} mt-1.5`}>
                    <option value="viewer">Viewer</option><option value="staff">Staff</option><option value="admin">Admin</option>
                  </select>
                </label>
              </>
            )}
          </div>
          <button type="submit" disabled={busy !== null || (invite.scope === 'clinic' && organizationClinics.length === 0)} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            {busy === 'invite' && <Loader2 className="h-4 w-4 animate-spin" />} Send invitation
          </button>
        </form>

        <form onSubmit={createClinic} className="rounded-xl border border-gray-800 bg-gray-900 p-5">
          <div className="flex items-center gap-2"><Building2 className="h-4 w-4 text-blue-400" /><h2 className="font-semibold text-white">Create a clinic</h2></div>
          <p className="mt-1 text-xs text-gray-500">
            {canCreateClinic
              ? `${clinicLimit! - organizationClinics.length} location slot${clinicLimit! - organizationClinics.length === 1 ? '' : 's'} remaining on this plan.`
              : 'An active subscription with available clinics.max capacity is required.'}
          </p>
          {billingLoadError && <p className="mt-2 text-xs text-amber-300">{billingLoadError}</p>}
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-gray-400 sm:col-span-2">Clinic name
              <input value={clinic.name} onChange={event => setClinic(current => ({ ...current, name: event.target.value }))} minLength={2} maxLength={160} className={`${inputClass} mt-1.5`} required />
            </label>
            <label className="text-xs text-gray-400">Country
              <select value={clinic.countryCode} onChange={event => selectCountry(event.target.value)} className={`${inputClass} mt-1.5`}>
                {countryOptions.map(option => <option key={option.countryCode} value={option.countryCode}>{option.label}</option>)}
              </select>
            </label>
            <label className="text-xs text-gray-400">Phone
              <input type="tel" value={clinic.phone} onChange={event => setClinic(current => ({ ...current, phone: event.target.value }))} placeholder={`+${clinic.defaultCallingCode} ...`} autoComplete="tel" minLength={7} maxLength={30} className={`${inputClass} mt-1.5`} required />
            </label>
            <label className="text-xs text-gray-400 sm:col-span-2">Timezone
              <input value={clinic.timezone} onChange={event => setClinic(current => ({ ...current, timezone: event.target.value }))} maxLength={100} className={`${inputClass} mt-1.5`} required />
            </label>
          </div>
          <button type="submit" disabled={busy !== null || !canCreateClinic} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            {busy === 'clinic' && <Loader2 className="h-4 w-4 animate-spin" />} Create clinic
          </button>
          {!canCreateClinic && <Link href="/dashboard/billing" className="mt-3 block text-center text-xs font-medium text-blue-400 hover:text-blue-300">Review subscription and clinic capacity</Link>}
        </form>
      </div>

      <section className="mb-5 overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
        <div className="border-b border-gray-800 p-5">
          <h2 className="font-semibold text-white">Pending invitations</h2>
          <p className="mt-1 text-xs text-gray-500">Expired invitations are excluded automatically.</p>
        </div>
        {pendingInvites.length === 0 ? (
          <p className="p-6 text-sm text-gray-500">No pending invitations.</p>
        ) : (
          <div className="divide-y divide-gray-800">
            {pendingInvites.map(pending => (
              <div key={pending.id} className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-200">{pending.email}</p>
                  <p className="mt-1 text-xs text-gray-500">
                    {pending.organizationRole
                      ? `${roleLabel(pending.organizationRole)} · Entire organization`
                      : `${roleLabel(pending.clinicRole)} · ${organizationClinics.find(item => item.id === pending.clinicId)?.name ?? 'Clinic'}`}
                    {' · '}Expires {formatDate(pending.expiresAt)}
                  </p>
                </div>
                <button type="button" onClick={() => void cancelInvite(pending)} disabled={busy !== null} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-red-500/20 px-3 py-2 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-50">
                  {busy === `invite-${pending.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Cancel invite
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
        <div className="flex flex-col gap-3 border-b border-gray-800 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-semibold text-white">Members</h2>
            <p className="mt-1 text-xs text-gray-500">Role changes and removals require a recently verified MFA session.</p>
          </div>
          <div className="flex items-center gap-2 text-xs text-gray-500"><ShieldCheck className="h-4 w-4" /> Tenant-scoped access</div>
        </div>
        {members.length === 0 ? (
          <p className="p-8 text-center text-sm text-gray-500">No members found on this page.</p>
        ) : (
          <div className="divide-y divide-gray-800">
            {members.map(member => {
              const draft = drafts[member.id] ?? memberDraft(member);
              const isCurrentUser = member.id === user?.id;
              return (
                <div key={member.id} className="p-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex items-start gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-800 text-sm font-semibold text-gray-300">{member.name.charAt(0).toUpperCase()}</div>
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-medium text-gray-200">{member.name}</p>
                          {isCurrentUser && <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] text-blue-300">You</span>}
                          {member.mfaRequired && <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-300">MFA required</span>}
                        </div>
                        <p className="mt-1 text-xs text-gray-500">{member.email} · {roleLabel(member.organizationRole)} · {member.status}</p>
                      </div>
                    </div>
                    <UserCog className="hidden h-5 w-5 text-gray-600 sm:block" />
                  </div>

                  <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    <label className="text-xs text-gray-400">Organization role
                      <select value={draft.organizationRole} onChange={event => updateDraftOrganizationRole(member.id, event.target.value as AuthRole | '')} disabled={isCurrentUser || busy !== null} className={`${inputClass} mt-1.5 disabled:opacity-50`}>
                        <option value="">No organization role</option><option value="viewer">Viewer</option><option value="staff">Staff</option><option value="admin">Admin</option><option value="owner">Owner</option>
                      </select>
                    </label>
                    {organizationClinics.map(item => (
                      <label key={item.id} className="text-xs text-gray-400">{item.name}
                        <select value={draft.clinicRoles[item.id] ?? ''} onChange={event => updateDraftClinicRole(member.id, item.id, event.target.value as AuthRole | '')} disabled={isCurrentUser || busy !== null} className={`${inputClass} mt-1.5 disabled:opacity-50`}>
                          <option value="">No clinic role</option><option value="viewer">Viewer</option><option value="staff">Staff</option><option value="admin">Admin</option><option value="owner">Owner</option>
                        </select>
                      </label>
                    ))}
                  </div>

                  <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
                    {isCurrentUser ? (
                      <p className="text-xs text-gray-500">Another organization owner must change or remove your access.</p>
                    ) : (
                      <>
                        <button type="button" onClick={() => void removeMember(member)} disabled={busy !== null} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-red-500/20 px-3 py-2 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-50">
                          {busy === `remove-${member.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Remove tenant access
                        </button>
                        <button type="button" onClick={() => void saveMember(member)} disabled={busy !== null} className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                          {busy === `member-${member.id}` && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Save access
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex items-center justify-between border-t border-gray-800 p-4">
          <p className="text-xs text-gray-500">Page {page} of {totalPages}</p>
          <div className="flex gap-2">
            <button type="button" onClick={() => setPage(current => Math.max(1, current - 1))} disabled={page <= 1 || busy !== null} aria-label="Previous member page" className="rounded-lg border border-gray-700 p-2 text-gray-400 hover:bg-gray-800 disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button>
            <button type="button" onClick={() => setPage(current => Math.min(totalPages, current + 1))} disabled={page >= totalPages || busy !== null} aria-label="Next member page" className="rounded-lg border border-gray-700 p-2 text-gray-400 hover:bg-gray-800 disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button>
          </div>
        </div>
      </section>
    </div>
  );
}
