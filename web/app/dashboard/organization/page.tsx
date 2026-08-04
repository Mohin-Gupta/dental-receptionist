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
import PageHeader from '@/components/ui/PageHeader';
import SectionCard from '@/components/ui/SectionCard';
import LoadingState from '../shared/components/LoadingState';
import EmptyState from '../shared/components/EmptyState';

const inputClass = 'ui-input mt-2';
const selectClass = 'ui-select mt-2';
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
      <div className="page-shell">
        <div className="surface-card flex min-h-[430px] items-center justify-center p-8 text-center">
          <div className="max-w-md">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-[#d7e3df] bg-surface-subtle text-muted">
              <ShieldAlert className="h-6 w-6" aria-hidden="true" />
            </span>
            <h1 className="mt-5 text-xl font-semibold tracking-[-0.03em] text-ink">Organization owner access required</h1>
            <p className="mt-2 text-sm leading-6 text-muted">Only an organization owner can manage tenant members, invitations, and clinic locations.</p>
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="page-shell">
        <div className="surface-card">
          <LoadingState height="min-h-[520px]" label="Loading organization controls" />
        </div>
      </div>
    );
  }

  return (
    <div className="page-shell">
      <PageHeader
        eyebrow="Tenant administration"
        title="Organization"
        description="Manage people, clinic locations, and subscription-controlled access from one secure workspace."
        icon={UsersRound}
        actions={(
          <button
            type="button"
            onClick={() => void load()}
            disabled={busy !== null}
            className="btn-secondary"
          >
            <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />
            Refresh
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
          <div>
            <p>{error}</p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
              {mfaAction && (
                <Link href="/mfa" className="font-bold text-danger underline decoration-danger/25 underline-offset-4 hover:decoration-danger">
                  {mfaAction === 'setup' ? 'Set up MFA' : 'Verify with MFA'}
                </Link>
              )}
              {paymentRequired && (
                <Link href="/dashboard/billing" className="font-bold text-danger underline decoration-danger/25 underline-offset-4 hover:decoration-danger">
                  Review plan
                </Link>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <article className="surface-card relative overflow-hidden p-5">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[0.68rem] font-bold uppercase tracking-[0.12em] text-muted">Members</p>
              <p className="mt-3 text-3xl font-semibold tracking-[-0.055em] text-ink">{total.toLocaleString()}</p>
              <p className="mt-1 text-xs text-muted">With tenant access</p>
            </div>
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#cfe5de] bg-brand-softer text-brand">
              <UsersRound className="h-[1.05rem] w-[1.05rem]" aria-hidden="true" />
            </span>
          </div>
        </article>
        <article className="surface-card relative overflow-hidden p-5">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[0.68rem] font-bold uppercase tracking-[0.12em] text-muted">Invitations</p>
              <p className="mt-3 text-3xl font-semibold tracking-[-0.055em] text-ink">{pendingInvites.length.toLocaleString()}</p>
              <p className="mt-1 text-xs text-muted">Waiting for acceptance</p>
            </div>
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#cee1e7] bg-info-soft text-info">
              <MailPlus className="h-[1.05rem] w-[1.05rem]" aria-hidden="true" />
            </span>
          </div>
        </article>
        <article className="surface-card relative overflow-hidden p-5">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[0.68rem] font-bold uppercase tracking-[0.12em] text-muted">Clinic capacity</p>
              <p className="mt-3 text-3xl font-semibold tracking-[-0.055em] text-ink">
                {organizationClinics.length}{clinicLimit !== null ? ` / ${clinicLimit}` : ''}
              </p>
              <p className="mt-1 text-xs text-muted">Locations in use</p>
            </div>
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#eadfca] bg-warning-soft text-warning">
              <Building2 className="h-[1.05rem] w-[1.05rem]" aria-hidden="true" />
            </span>
          </div>
        </article>
      </div>

      <SectionCard
        title="Clinic lifecycle"
        description="Archived clinics retain their records but cannot receive calls, messages, appointments, or member traffic."
        eyebrow="Locations"
        icon={Building2}
        className="mb-5"
        contentClassName="p-0 sm:p-0"
      >
        {managedClinics.length === 0 ? (
          <EmptyState icon={Building2} title="No clinic locations" message="Clinic locations will appear here once they are created." compact />
        ) : (
          <div className="divide-y divide-[#e7ecea]">
            {managedClinics.map(item => (
              <article key={item.id} className="flex flex-col gap-4 p-4 transition-colors hover:bg-[#fafcfb] sm:flex-row sm:items-center sm:justify-between sm:p-5">
                <div className="flex min-w-0 items-start gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[#d5e4df] bg-surface-subtle text-brand">
                    <Building2 className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold text-ink">{item.name}</h3>
                      <span className={`status-pill capitalize ${item.status === 'active' ? 'status-success' : 'status-neutral'}`}>
                        {item.status}
                      </span>
                      {item.id === activeClinicId && <span className="status-pill status-info">Selected</span>}
                    </div>
                    <p className="mt-1.5 text-xs leading-5 text-muted">
                      {item.phone} · {item.timezone} · {item._count.memberships} member assignment{item._count.memberships === 1 ? '' : 's'}
                      {item.status === 'active' && ` · ${item._count.appointments} future appointment${item._count.appointments === 1 ? '' : 's'}`}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void changeClinicStatus(item)}
                  disabled={busy !== null}
                  className={`inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-xl border px-3 text-xs font-bold transition disabled:cursor-not-allowed disabled:opacity-50 ${
                    item.status === 'active'
                      ? 'border-[#ecd9b8] bg-warning-soft text-warning hover:border-[#dfc68f]'
                      : 'border-[#cce7dc] bg-success-soft text-success hover:border-[#acd9c8]'
                  }`}
                >
                  {busy === `clinic-status-${item.id}` ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : item.status === 'active' ? (
                    <Archive className="h-3.5 w-3.5" aria-hidden="true" />
                  ) : (
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {item.status === 'active' ? 'Archive' : 'Restore'}
                </button>
              </article>
            ))}
          </div>
        )}
      </SectionCard>

      <div className="mb-5 grid gap-5 xl:grid-cols-2">
        <form onSubmit={sendInvite}>
          <SectionCard
            title="Invite a member"
            description="Access begins only after the recipient authenticates and accepts."
            eyebrow="People"
            icon={MailPlus}
            className="h-full"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="ui-label sm:col-span-2">Email
                <input type="email" value={invite.email} onChange={event => setInvite(current => ({ ...current, email: event.target.value }))} autoComplete="email" className={inputClass} required />
              </label>
              <label className="ui-label">Access scope
                <select value={invite.scope} onChange={event => setInvite(current => ({ ...current, scope: event.target.value as 'organization' | 'clinic' }))} className={selectClass}>
                  <option value="clinic">One clinic</option><option value="organization">Entire organization</option>
                </select>
              </label>
              {invite.scope === 'organization' ? (
                <label className="ui-label">Organization role
                  <select value={invite.organizationRole} onChange={event => setInvite(current => ({ ...current, organizationRole: event.target.value as typeof current.organizationRole }))} className={selectClass}>
                    <option value="viewer">Viewer</option><option value="admin">Admin</option>
                  </select>
                  <span className="ui-help block font-normal">Owner access can be granted after acceptance through an MFA-protected role change.</span>
                </label>
              ) : (
                <>
                  <label className="ui-label">Clinic
                    <select value={invite.clinicId} onChange={event => setInvite(current => ({ ...current, clinicId: event.target.value }))} className={selectClass} required>
                      {organizationClinics.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                    </select>
                  </label>
                  <label className="ui-label sm:col-span-2">Clinic role
                    <select value={invite.clinicRole} onChange={event => setInvite(current => ({ ...current, clinicRole: event.target.value as typeof current.clinicRole }))} className={selectClass}>
                      <option value="viewer">Viewer</option><option value="staff">Staff</option><option value="admin">Admin</option>
                    </select>
                  </label>
                </>
              )}
            </div>
            <button type="submit" disabled={busy !== null || (invite.scope === 'clinic' && organizationClinics.length === 0)} className="btn-primary mt-5 w-full">
              {busy === 'invite' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />} Send invitation
            </button>
          </SectionCard>
        </form>

        <form onSubmit={createClinic}>
          <SectionCard
            title="Create a clinic"
            description={canCreateClinic
              ? `${clinicLimit! - organizationClinics.length} location slot${clinicLimit! - organizationClinics.length === 1 ? '' : 's'} remaining on this plan.`
              : 'An active subscription with available clinics.max capacity is required.'}
            eyebrow="Locations"
            icon={Building2}
            className="h-full"
          >
            {billingLoadError && <div className="alert-warning mb-4"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{billingLoadError}</div>}
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="ui-label sm:col-span-2">Clinic name
                <input value={clinic.name} onChange={event => setClinic(current => ({ ...current, name: event.target.value }))} minLength={2} maxLength={160} className={inputClass} required />
              </label>
              <label className="ui-label">Country
                <select value={clinic.countryCode} onChange={event => selectCountry(event.target.value)} className={selectClass}>
                  {countryOptions.map(option => <option key={option.countryCode} value={option.countryCode}>{option.label}</option>)}
                </select>
              </label>
              <label className="ui-label">Phone
                <input type="tel" value={clinic.phone} onChange={event => setClinic(current => ({ ...current, phone: event.target.value }))} placeholder={`+${clinic.defaultCallingCode} ...`} autoComplete="tel" minLength={7} maxLength={30} className={inputClass} required />
              </label>
              <label className="ui-label sm:col-span-2">Timezone
                <input value={clinic.timezone} onChange={event => setClinic(current => ({ ...current, timezone: event.target.value }))} maxLength={100} className={inputClass} required />
              </label>
            </div>
            <button type="submit" disabled={busy !== null || !canCreateClinic} className="btn-primary mt-5 w-full">
              {busy === 'clinic' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />} Create clinic
            </button>
            {!canCreateClinic && <Link href="/dashboard/billing" className="mt-3 block text-center text-xs font-bold text-brand hover:text-brand-dark">Review subscription and clinic capacity</Link>}
          </SectionCard>
        </form>
      </div>

      <SectionCard
        title="Pending invitations"
        description="Expired invitations are excluded automatically."
        eyebrow="Access queue"
        icon={MailPlus}
        className="mb-5"
        contentClassName="p-0 sm:p-0"
      >
        {pendingInvites.length === 0 ? (
          <EmptyState icon={MailPlus} title="No pending invitations" message="New invitations awaiting acceptance will be listed here." compact />
        ) : (
          <div className="divide-y divide-[#e7ecea]">
            {pendingInvites.map(pending => (
              <article key={pending.id} className="flex flex-col gap-3 p-4 transition-colors hover:bg-[#fafcfb] sm:flex-row sm:items-center sm:justify-between sm:p-5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-semibold text-ink">{pending.email}</p>
                    <span className="status-pill status-warning">Pending</span>
                  </div>
                  <p className="mt-1.5 text-xs leading-5 text-muted">
                    {pending.organizationRole
                      ? `${roleLabel(pending.organizationRole)} · Entire organization`
                      : `${roleLabel(pending.clinicRole)} · ${organizationClinics.find(item => item.id === pending.clinicId)?.name ?? 'Clinic'}`}
                    {' · '}Expires {formatDate(pending.expiresAt)}
                  </p>
                </div>
                <button type="button" onClick={() => void cancelInvite(pending)} disabled={busy !== null} className="btn-danger-soft min-h-9 shrink-0 px-3 py-2 text-[0.7rem]">
                  {busy === `invite-${pending.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />} Cancel invite
                </button>
              </article>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Members"
        description="Role changes and removals require a recently verified MFA session."
        eyebrow="Access directory"
        icon={UsersRound}
        contentClassName="p-0 sm:p-0"
        action={<span className="status-pill status-success"><ShieldCheck className="h-3 w-3" aria-hidden="true" />Tenant scoped</span>}
      >
        {members.length === 0 ? (
          <EmptyState icon={UsersRound} title="No members on this page" message="Tenant members will appear here as access is granted." compact />
        ) : (
          <div className="divide-y divide-[#e7ecea]">
            {members.map(member => {
              const draft = drafts[member.id] ?? memberDraft(member);
              const isCurrentUser = member.id === user?.id;
              return (
                <article key={member.id} className="p-4 transition-colors hover:bg-[#fafcfb] sm:p-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <div className="avatar h-10 w-10 text-sm">{member.name.charAt(0).toUpperCase()}</div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-sm font-semibold text-ink">{member.name}</h3>
                          {isCurrentUser && <span className="status-pill status-info">You</span>}
                          {member.mfaRequired && <span className="status-pill status-success">MFA required</span>}
                        </div>
                        <p className="mt-1 break-words text-xs leading-5 text-muted">{member.email} · {roleLabel(member.organizationRole)} · {member.status}</p>
                      </div>
                    </div>
                    <UserCog className="hidden h-5 w-5 text-[#9ba8a3] sm:block" aria-hidden="true" />
                  </div>

                  <div className="surface-card-soft mt-4 grid gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
                    <label className="ui-label">Organization role
                      <select value={draft.organizationRole} onChange={event => updateDraftOrganizationRole(member.id, event.target.value as AuthRole | '')} disabled={isCurrentUser || busy !== null} className={selectClass}>
                        <option value="">No organization role</option><option value="viewer">Viewer</option><option value="staff">Staff</option><option value="admin">Admin</option><option value="owner">Owner</option>
                      </select>
                    </label>
                    {organizationClinics.map(item => (
                      <label key={item.id} className="ui-label">{item.name}
                        <select value={draft.clinicRoles[item.id] ?? ''} onChange={event => updateDraftClinicRole(member.id, item.id, event.target.value as AuthRole | '')} disabled={isCurrentUser || busy !== null} className={selectClass}>
                          <option value="">No clinic role</option><option value="viewer">Viewer</option><option value="staff">Staff</option><option value="admin">Admin</option><option value="owner">Owner</option>
                        </select>
                      </label>
                    ))}
                  </div>

                  <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
                    {isCurrentUser ? (
                      <p className="rounded-lg bg-surface-subtle px-3 py-2 text-xs text-muted">Another organization owner must change or remove your access.</p>
                    ) : (
                      <>
                        <button type="button" onClick={() => void removeMember(member)} disabled={busy !== null} className="btn-danger-soft min-h-9 px-3 py-2 text-[0.7rem]">
                          {busy === `remove-${member.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />} Remove tenant access
                        </button>
                        <button type="button" onClick={() => void saveMember(member)} disabled={busy !== null} className="btn-primary min-h-9 px-3 py-2 text-[0.7rem]">
                          {busy === `member-${member.id}` && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />} Save access
                        </button>
                      </>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}

        <nav className="flex items-center justify-between border-t border-line bg-[#fbfcfc] p-4" aria-label="Member pages">
          <p className="text-[0.7rem] font-medium text-muted">Page <span className="font-bold text-ink-soft">{page}</span> of <span className="font-bold text-ink-soft">{totalPages}</span></p>
          <div className="flex gap-2">
            <button type="button" onClick={() => setPage(current => Math.max(1, current - 1))} disabled={page <= 1 || busy !== null} aria-label="Previous member page" className="icon-button border border-line bg-white disabled:opacity-40"><ChevronLeft className="h-4 w-4" aria-hidden="true" /></button>
            <button type="button" onClick={() => setPage(current => Math.min(totalPages, current + 1))} disabled={page >= totalPages || busy !== null} aria-label="Next member page" className="icon-button border border-line bg-white disabled:opacity-40"><ChevronRight className="h-4 w-4" aria-hidden="true" /></button>
          </div>
        </nav>
      </SectionCard>
    </div>
  );
}
