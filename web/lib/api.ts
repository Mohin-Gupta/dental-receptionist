import axios from 'axios';

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL,
  timeout: 10000,
});

export default api;

// Types
export interface Appointment {
  id: string;
  reason: string;
  startAt: string;
  endAt: string;
  status: string;
  confirmed: boolean;
  createdAt: string;
  patient: {
    id: string;
    name: string;
    phone: string;
  };
}

export interface CallLog {
  id: string;
  vapiCallId: string;
  direction: string;
  durationSecs: number;
  outcome: string;
  createdAt: string;
  transcript: { role: string; content: string }[];
  patient?: {
    name: string;
    phone: string;
  };
}

export interface Patient {
  id: string;
  name: string;
  phone: string;
  email?: string;
  createdAt: string;
  appointments: Appointment[];
}

export interface DashboardStats {
  todayAppointments: number;
  upcomingAppointments: number;
  totalPatients: number;
  callsToday: number;
  todayAppointmentsList: Appointment[];
}