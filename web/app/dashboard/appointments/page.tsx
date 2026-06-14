'use client';

import { useEffect, useState } from 'react';
import api, { Appointment } from '@/lib/api';
import { format } from 'date-fns';
import {
  Calendar,
  Filter,
  ChevronLeft,
  ChevronRight,
  Clock,
  CheckCircle,
  XCircle,
  AlertCircle,
} from 'lucide-react';

function toIST(utcStr: string): string {
  const d = new Date(new Date(utcStr).getTime() + 5.5 * 60 * 60 * 1000);
  return format(d, 'MMM d, yyyy · h:mm a');
}

interface StatusConfigItem {
  color: string;
  bg: string;
  icon: React.ElementType;
}

const STATUS_CONFIG: Record<string, StatusConfigItem> = {
  confirmed: {
    color: 'text-emerald-400',
    bg: 'bg-emerald-400/10',
    icon: CheckCircle,
  },
  scheduled: {
    color: 'text-blue-400',
    bg: 'bg-blue-400/10',
    icon: Clock,
  },
  cancelled: {
    color: 'text-red-400',
    bg: 'bg-red-400/10',
    icon: XCircle,
  },
  completed: {
    color: 'text-gray-400',
    bg: 'bg-gray-400/10',
    icon: AlertCircle,
  },
};

function StatusBadge({ status }: { status: string }) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.completed;
  const Icon = config.icon;

  return (
    <div
      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full ${config.bg} w-fit`}
    >
      <Icon className={`w-3 h-3 ${config.color}`} />
      <span className={`text-xs font-medium ${config.color} capitalize`}>
        {status}
      </span>
    </div>
  );
}

interface AppointmentsResponse {
  appointments: Appointment[];
  total: number;
  page: number;
  limit: number;
}

export default function AppointmentsPage() {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);

  const totalPages = Math.ceil(total / 20);

  useEffect(() => {
    let mounted = true;

    const loadAppointments = async () => {
      try {
        const params: Record<string, string | number> = {
          page,
          limit: 20,
        };

        if (statusFilter) {
          params.status = statusFilter;
        }

        const response = await api.get<AppointmentsResponse>(
          '/dashboard/appointments',
          { params }
        );

        if (!mounted) return;

        setAppointments(response.data.appointments);
        setTotal(response.data.total);
      } catch (err) {
        console.error(err);
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    loadAppointments();

    return () => {
      mounted = false;
    };
  }, [page, statusFilter]);

  return (
    <div className="p-4 md:p-6 lg:p-8">
      <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">
            Appointments
          </h1>

          <p className="text-sm text-gray-400 mt-1">
            {total} total records
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-gray-400" />

          <select
            value={statusFilter}
            onChange={(e) => {
              setLoading(true);
              setStatusFilter(e.target.value);
              setPage(1);
            }}
            className="w-full md:w-auto text-sm bg-gray-800 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All statuses</option>
            <option value="scheduled">Scheduled</option>
            <option value="confirmed">Confirmed</option>
            <option value="cancelled">Cancelled</option>
            <option value="completed">Completed</option>
          </select>
        </div>
      </div>

      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : appointments.length === 0 ? (
          <div className="py-20 text-center">
            <Calendar className="w-8 h-8 text-gray-700 mx-auto mb-3" />
            <p className="text-sm text-gray-500">
              No appointments found
            </p>
          </div>
        ) : (
          <>
            {/* Desktop Table */}
            <div className="hidden md:block">
              <div className="grid grid-cols-5 px-6 py-3 border-b border-gray-800 text-xs font-medium text-gray-500 uppercase tracking-wider">
                <span>Patient</span>
                <span>Reason</span>
                <span>Date & Time</span>
                <span>Status</span>
                <span>Phone</span>
              </div>

              <div className="divide-y divide-gray-800">
                {appointments.map((appt) => (
                  <div
                    key={appt.id}
                    className="grid grid-cols-5 px-6 py-4 hover:bg-gray-800/50 transition-colors items-center"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-blue-600/20 flex items-center justify-center">
                        <span className="text-blue-400 text-xs font-semibold">
                          {appt.patient.name.charAt(0).toUpperCase()}
                        </span>
                      </div>

                      <span className="text-sm font-medium text-white">
                        {appt.patient.name}
                      </span>
                    </div>

                    <span className="text-sm text-gray-300">
                      {appt.reason}
                    </span>

                    <span className="text-sm text-gray-300">
                      {toIST(appt.startAt)}
                    </span>

                    <StatusBadge status={appt.status} />

                    <span className="text-sm text-gray-400 font-mono">
                      {appt.patient.phone}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Mobile Cards */}
            <div className="md:hidden divide-y divide-gray-800">
              {appointments.map((appt) => (
                <div key={appt.id} className="p-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full bg-blue-600/20 flex items-center justify-center">
                        <span className="text-blue-400 text-sm font-semibold">
                          {appt.patient.name.charAt(0).toUpperCase()}
                        </span>
                      </div>

                      <div>
                        <p className="text-white font-medium">
                          {appt.patient.name}
                        </p>

                        <p className="text-xs text-gray-500">
                          {appt.patient.phone}
                        </p>
                      </div>
                    </div>

                    <StatusBadge status={appt.status} />
                  </div>

                  <div>
                    <p className="text-xs text-gray-500 mb-1">
                      Reason
                    </p>

                    <p className="text-sm text-gray-300">
                      {appt.reason}
                    </p>
                  </div>

                  <div>
                    <p className="text-xs text-gray-500 mb-1">
                      Appointment Time
                    </p>

                    <p className="text-sm text-gray-300">
                      {toIST(appt.startAt)}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            {totalPages > 1 && (
              <div className="px-4 md:px-6 py-4 border-t border-gray-800 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <span className="text-xs text-gray-500">
                  Page {page} of {totalPages} · {total} records
                </span>

                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setLoading(true);
                      setPage((p) => Math.max(1, p - 1));
                    }}
                    disabled={page === 1}
                    className="flex-1 md:flex-none flex items-center justify-center gap-1 text-xs px-3 py-2 rounded-lg border border-gray-700 text-gray-300 disabled:opacity-40 hover:bg-gray-800"
                  >
                    <ChevronLeft className="w-3 h-3" />
                    Previous
                  </button>

                  <button
                    onClick={() => {
                      setLoading(true);
                      setPage((p) =>
                        Math.min(totalPages, p + 1)
                      );
                    }}
                    disabled={page === totalPages}
                    className="flex-1 md:flex-none flex items-center justify-center gap-1 text-xs px-3 py-2 rounded-lg border border-gray-700 text-gray-300 disabled:opacity-40 hover:bg-gray-800"
                  >
                    Next
                    <ChevronRight className="w-3 h-3" />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}