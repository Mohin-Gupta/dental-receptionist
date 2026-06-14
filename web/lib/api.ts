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
  totalPatients: number;
  callsToday: number;
  todayAppointmentsList: Appointment[];
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