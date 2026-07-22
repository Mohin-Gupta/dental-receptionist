import axios, { AxiosHeaders } from 'axios';

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL,
  timeout: 10000,
  withCredentials: true,
});

let csrfToken: string | null = null;
let activeOrganizationId: string | null = null;
let activeClinicId: string | null = null;

export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

export function setAuthScope(organizationId: string | null, clinicId: string | null) {
  activeOrganizationId = organizationId;
  activeClinicId = clinicId;
}

/** Stable mutation identifier for server/provider-side replay protection. */
export function createIdempotencyKey(scope: string): string {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${scope}:${id}`;
}

export async function refreshCsrfToken(): Promise<string | null> {
  const response = await api.get<{ csrfToken: string }>('/auth/csrf');
  csrfToken = response.data.csrfToken;
  return csrfToken;
}

api.interceptors.request.use((config) => {
  const method = config.method?.toUpperCase();
  const headers = AxiosHeaders.from(config.headers);
  if (activeOrganizationId) headers.set('X-Organization-Id', activeOrganizationId);
  if (activeClinicId) headers.set('X-Clinic-Id', activeClinicId);
  if (csrfToken && method && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    headers.set('X-CSRF-Token', csrfToken);
  }
  config.headers = headers;
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (
      typeof window !== 'undefined' &&
      error?.response?.status === 401 &&
      !window.location.pathname.startsWith('/sign-in') &&
      !window.location.pathname.startsWith('/forgot-password') &&
      !window.location.pathname.startsWith('/reset-password') &&
      !window.location.pathname.startsWith('/accept-invite') &&
      !window.location.pathname.startsWith('/register') &&
      !window.location.pathname.startsWith('/verify-email')
    ) {
      window.location.href = '/sign-in';
    }
    return Promise.reject(error);
  }
);

export default api;

export type AuthRole = 'owner' | 'admin' | 'staff' | 'viewer';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

export interface AuthMembership {
  clinicId: string;
  role: AuthRole;
}

export interface AuthOrganization {
  id: string;
  name: string;
  role: AuthRole | null;
}

export interface AuthClinic {
  id: string;
  organizationId: string;
  name: string;
  role: AuthRole | null;
}

export interface AuthMeResponse {
  user: AuthUser;
  activeOrganization: {
    id: string;
    role: AuthRole | null;
  };
  activeClinic: {
    id: string;
    organizationId: string;
    role: AuthRole;
    clinicRole: AuthRole | null;
  };
  organizations: AuthOrganization[];
  clinics: AuthClinic[];
  memberships: AuthMembership[];
}

export interface OrganizationRegistrationResponse {
  success: boolean;
  emailVerificationRequired: boolean;
  verificationDeliveryPending?: boolean;
  organizationId?: string;
  replayed?: boolean;
}

export interface Patient {
  id: string;
  name: string;
  phone: string;
  email?: string;
  createdAt: string;
}

export interface Appointment {
  id: string;
  doctorId: string;
  reason: string;
  startAt: string;
  endAt: string;
  status: string;
  confirmed: boolean;
  createdAt: string;
  patient: Patient;
  doctor?: Doctor;
}

export interface CallLog {
  id: string;
  vapiCallId: string;
  direction: string;
  phoneNumber: string | null; // raw number from the call, saved directly regardless of patient match
  durationSecs: number | null;
  outcome: string | null;
  createdAt: string;
  transcript: string | null;
  patient?: Patient;
}

export interface PatientWithStats extends Patient {
  appointments: Appointment[];
  _count: { appointments: number };
}

export interface DashboardStats {
  todayAppointments: number;
  upcomingAppointments: number;
  pastAppointments: number;
  cancelledAppointments: number;
  totalPatients: number;
  callsToday: number;
  todayAppointmentsList: Appointment[];
  timezone: string; // IANA timezone string e.g. "Asia/Kolkata", "America/New_York"
}

export interface AppointmentsResponse {
  appointments: Appointment[];
  total: number;
  page: number;
  tab: string;
  timezone: string; // IANA timezone string
}

export interface CallsResponse {
  calls: CallLog[];
  total: number;
  timezone: string; // IANA timezone string
}

export interface RescheduleResponse {
  success: boolean;
  appointment: Appointment;
  message: string;
}

export interface CancelResponse {
  success: boolean;
  message: string;
}

// ── Manual booking from admin dashboard ───────────────────────────────────────

export interface AvailableSlot {
  start: string; // "HH:MM" 24-hour, used as the `time` field when booking
  end: string;
  label: string; // human readable e.g. "10:30 AM"
}

export interface AvailableSlotsResponse {
  date: string;
  slots: AvailableSlot[];
}

export interface BookResponse {
  success: boolean;
  appointment: Appointment;
  message: string;
}

export interface ClinicSettings {
  organization: OrganizationSettings;
  clinic: BranchSettings;
  doctors: Doctor[];
}

export interface OrganizationSettings {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  about: string | null;
  services: string[] | null;
  planTier: string;
  createdAt: string;
}

export interface BranchSettings {
  id: string;
  organizationId: string;
  name: string;
  phone: string;
  timezone: string;
  googleCalendarId: string | null;
  businessHours: Record<string, { open: string; close: string } | null>;
  clinicAddress: string | null;
  clinicEmail: string | null;
  clinicWebsite: string | null;
  clinicAbout: string | null;
  clinicServices: string[] | null;
  createdAt: string;
}

export interface Doctor {
  id: string;
  organizationId: string;
  userId: string | null;
  name: string;
  phone: string | null;
  email: string | null;
  qualification: string | null;
  yearsExperience: number | null;
  specialty: string | null;
  status: string;
}

export interface DoctorsResponse {
  doctors: Doctor[];
}

// ── Billing and usage ────────────────────────────────────────────────────────

export interface BillingSubscription {
  id: string;
  planKey: string;
  status: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  trialEnd: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  graceUntil: string | null;
}

export interface BillingUsageGroup {
  metric: string;
  clinicId: string | null;
  clinicName: string | null;
  currency: string | null;
  quantity: string;
  ratedAmountMinor: string | null;
  eventCount: number;
  unratedEventCount: number;
}

export interface TenantBudget {
  id: string;
  clinicId: string | null;
  metric: string;
  period: 'daily' | 'monthly' | 'billing_period';
  currency: string | null;
  softLimitQuantity: string | null;
  hardLimitQuantity: string | null;
  softLimitAmountMinor: string | null;
  hardLimitAmountMinor: string | null;
  enforcementMode: 'alert' | 'soft_block' | 'hard_block';
  alertThresholds: number[];
  effectiveAt: string;
  expiresAt: string | null;
}

export interface BillingSummary {
  organization: {
    id: string;
    status: string;
    planKey: string;
  };
  billingAccount: {
    provider: string;
    status: string;
    currency: string;
  } | null;
  subscription: BillingSubscription | null;
  period: { start: string; end: string };
  usage: BillingUsageGroup[];
  estimate: {
    kind: 'usage_only_unfinalized';
    amounts: Array<{ currency: string; amountMinor: string }>;
    excludesTaxesDiscountsAndBaseFees: boolean;
  };
  entitlements: Array<{
    key: string;
    enabled: boolean;
    limit: string | null;
    unit: string | null;
    value: unknown;
    effectiveAt: string;
    expiresAt: string | null;
  }>;
  budgets: TenantBudget[];
}

export interface HostedBillingSession {
  id: string;
  url: string;
}

// ── Tenant provider integrations ────────────────────────────────────────────

export type IntegrationProvider = 'vapi' | 'twilio';
export type IntegrationStatus = 'provisioning' | 'active' | 'inactive';

export interface ProviderResourceView {
  id: string;
  organizationId: string;
  clinicId: string | null;
  providerAccountId: string;
  provider: IntegrationProvider;
  resourceType: 'phone_number' | 'assistant' | 'messaging_service';
  externalId: string;
  displayName: string | null;
  status: IntegrationStatus;
  config: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderAccountView {
  id: string;
  organizationId: string;
  provider: IntegrationProvider;
  externalAccountId: string;
  status: IntegrationStatus;
  hasCredentials: boolean;
  credentialSource: 'tenant' | 'platform';
  config: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  resources: ProviderResourceView[];
}

export interface IntegrationsResponse {
  accounts: ProviderAccountView[];
}

export interface IntegrationHealthItem {
  id: string;
  provider: string;
  status: string;
  configured: boolean;
  issues: string[];
  resourceType?: string;
  clinicId?: string | null;
}

export interface IntegrationsHealthResponse {
  scope: 'configuration_only';
  organizationStatus: string | null;
  healthy: boolean;
  accounts: IntegrationHealthItem[];
  resources: IntegrationHealthItem[];
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

// ── Timezone formatting helpers (used across all dashboard pages) ─────────────

/**
 * Formats a UTC date string for display in the given IANA timezone.
 * Falls back to "Asia/Kolkata" if timezone is missing (backward compat).
 */
export function formatDateTime(utcStr: string, timezone: string = 'Asia/Kolkata'): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    month:    'short',
    day:      'numeric',
    year:     'numeric',
    hour:     'numeric',
    minute:   '2-digit',
    hour12:   true,
  }).format(new Date(utcStr));
}

/** Formats time only (e.g. "10:30 AM") in the given timezone. */
export function formatTime(utcStr: string, timezone: string = 'Asia/Kolkata'): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour:     'numeric',
    minute:   '2-digit',
    hour12:   true,
  }).format(new Date(utcStr));
}

/** Formats date only (e.g. "Jun 15, 2025") in the given timezone. */
export function formatDate(utcStr: string, timezone: string = 'Asia/Kolkata'): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    month:    'short',
    day:      'numeric',
    year:     'numeric',
  }).format(new Date(utcStr));
}

/** Returns the current local date/time in the given timezone as a Date-like object for display. */
export function nowInTimezone(timezone: string = 'Asia/Kolkata'): {
  formatted: string;
  time: string;
} {
  const now = new Date();
  return {
    formatted: new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday:  'long',
      month:    'long',
      day:      'numeric',
      year:     'numeric',
    }).format(now),
    time: new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour:     'numeric',
      minute:   '2-digit',
      hour12:   true,
    }).format(now),
  };
}
