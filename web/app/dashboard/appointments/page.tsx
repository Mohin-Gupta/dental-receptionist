'use client';

import { useEffect, useState } from 'react';
import api, { Appointment } from '@/lib/api';
import { format } from 'date-fns';
import { Search, Filter } from 'lucide-react';

function toIST(utcStr: string) {
  const d = new Date(new Date(utcStr).getTime() + 5.5 * 60 * 60 * 1000);
  return format(d, 'MMM d, yyyy h:mm a');
}

function statusColor(status: string) {
  switch (status) {
    case 'confirmed': return 'bg-green-100 text-green-700';
    case 'scheduled': return 'bg-blue-100 text-blue-700';
    case 'cancelled': return 'bg-red-100 text-red-700';
    case 'completed': return 'bg-gray-100 text-gray-600';
    default: return 'bg-gray-100 text-gray-600';
  }
}

export default function AppointmentsPage() {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);

  const fetchAppointments = () => {
    setLoading(true);
    const params: any = { page, limit: 20 };
    if (status) params.status = status;

    api.get('/dashboard/appointments', { params })
      .then(r => {
        setAppointments(r.data.appointments);
        setTotal(r.data.total);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchAppointments(); }, [page, status]);

  const totalPages = Math.ceil(total / 20);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Appointments</h1>
          <p className="text-sm text-gray-500 mt-1">{total} total</p>
        </div>

        {/* Filter */}
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-gray-400" />
          <select
            value={status}
            onChange={e => { setStatus(e.target.value); setPage(1); }}
            className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All statuses</option>
            <option value="scheduled">Scheduled</option>
            <option value="confirmed">Confirmed</option>
            <option value="cancelled">Cancelled</option>
            <option value="completed">Completed</option>
          </select>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200">
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : appointments.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-sm text-gray-400">No appointments found</p>
          </div>
        ) : (
          <>
            {/* Table header */}
            <div className="grid grid-cols-5 px-5 py-3 border-b border-gray-100 text-xs font-medium text-gray-500 uppercase tracking-wide">
              <span>Patient</span>
              <span>Reason</span>
              <span>Date & Time</span>
              <span>Status</span>
              <span>Phone</span>
            </div>

            <div className="divide-y divide-gray-50">
              {appointments.map(appt => (
                <div key={appt.id} className="grid grid-cols-5 px-5 py-4 hover:bg-gray-50 items-center">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-blue-50 flex items-center justify-center flex-shrink-0">
                      <span className="text-blue-600 text-xs font-semibold">
                        {appt.patient.name.charAt(0).toUpperCase()}
                      </span>
                    </div>
                    <span className="text-sm font-medium text-gray-900">{appt.patient.name}</span>
                  </div>
                  <span className="text-sm text-gray-600">{appt.reason}</span>
                  <span className="text-sm text-gray-600">{toIST(appt.startAt)}</span>
                  <span className={`text-xs px-2 py-1 rounded-full font-medium w-fit ${statusColor(appt.status)}`}>
                    {appt.status}
                  </span>
                  <span className="text-sm text-gray-600">{appt.patient.phone}</span>
                </div>
              ))}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="px-5 py-4 border-t border-gray-100 flex items-center justify-between">
                <span className="text-xs text-gray-500">Page {page} of {totalPages}</span>
                <div className="flex gap-2">
                  <button
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={page === 1}
                    className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 disabled:opacity-40 hover:bg-gray-50"
                  >
                    Previous
                  </button>
                  <button
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    disabled={page === totalPages}
                    className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 disabled:opacity-40 hover:bg-gray-50"
                  >
                    Next
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