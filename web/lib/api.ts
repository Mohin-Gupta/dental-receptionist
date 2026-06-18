import axios from 'axios';

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL,
  timeout: 10000,
});

export default api;

export interface Patient {
  id: string;
  name: string;
  phone: string;
  email?: string;
  createdAt: string;
}

export interface Appointment {
  id: string;
  reason: string;
  startAt: string;
  endAt: string;
  status: string;
  confirmed: boolean;
  createdAt: string;
  patient: Patient;
}

export interface CallLog {
  id: string;
  vapiCallId: string;
  direction: string;
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

export interface ClinicSettings {
  id: string;
  name: string;
  phone: string;
  timezone: string;
  googleCalendarId: string | null;
  businessHours: Record<string, { open: string; close: string } | null>;
  aiPersonality: Record<string, string>;
  planTier: string;
  doctorName: string | null;
  doctorPhone: string | null;
  doctorQualification: string | null;
  doctorYOE: number | null;
  doctorSpecialty: string | null;
  clinicAddress: string | null;
  clinicEmail: string | null;
  clinicWebsite: string | null;
  clinicAbout: string | null;
  clinicServices: string[] | null;
  createdAt: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

export interface CancelResponse {
  success: boolean;
  message: string;
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