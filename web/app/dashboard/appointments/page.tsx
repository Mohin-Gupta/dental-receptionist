'use client';

import { useCallback, useEffect, useState } from 'react';
import api, { Appointment, AppointmentsResponse, RescheduleResponse, CancelResponse, BookResponse, AvailableSlotsResponse, AvailableSlot, formatDateTime } from '@/lib/api';
import {
  Calendar, ChevronLeft, ChevronRight,
  Clock, CheckCircle, XCircle, AlertCircle,
  CalendarClock, X, Loader2, Trash2, Plus,
} from 'lucide-react';

interface StatusConfigItem {
  color: string;
  bg: string;
  icon: React.ElementType;
}

const STATUS_CONFIG: Record<string, StatusConfigItem> = {
  confirmed: { color: 'text-emerald-400', bg: 'bg-emerald-400/10', icon: CheckCircle },
  scheduled: { color: 'text-blue-400', bg: 'bg-blue-400/10', icon: Clock },
  cancelled: { color: 'text-red-400', bg: 'bg-red-400/10', icon: XCircle },
  completed: { color: 'text-gray-400', bg: 'bg-gray-400/10', icon: AlertCircle },
};

function StatusBadge({ status }: { status: string }) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.completed;
  const Icon = config.icon;
  return (
    <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full ${config.bg} w-fit`}>
      <Icon className={`w-3 h-3 ${config.color}`} />
      <span className={`text-xs font-medium ${config.color} capitalize`}>{status}</span>
    </div>
  );
}

type TabType = 'upcoming' | 'past' | 'cancelled';

// ── New Appointment Modal ─────────────────────────────────────────────────────
interface NewAppointmentModalProps {
  onClose: () => void;
  onSuccess: (message: string) => void;
}

function NewAppointmentModal({ onClose, onSuccess }: NewAppointmentModalProps) {
  const [patientName, setPatientName] = useState('');
  const [patientPhone, setPatientPhone] = useState('');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState('');
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);

  const [slots, setSlots] = useState<AvailableSlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Computed once per mount via useMemo, not directly during render — avoids
  // calling the impure Date.now()/new Date() during the render pass itself.
  const [dateLimits] = useState(() => {
  const now = new Date();
  const max = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  return {
    minDate: now.toISOString().split('T')[0],
    maxDate: max.toISOString().split('T')[0],
  };
});

const { minDate, maxDate } = dateLimits;

  // Fetch available slots whenever the date changes — same logic Maya uses on calls
  useEffect(() => {
    if (!date) {
      setSlots([]);
      setSelectedSlot(null);
      return;
    }

    setSlotsLoading(true);
    setSlotsError('');
    setSelectedSlot(null);

    api.get<AvailableSlotsResponse>('/dashboard/available-slots', { params: { date } })
      .then(r => setSlots(r.data.slots))
      .catch(() => setSlotsError('Failed to load available slots for this date.'))
      .finally(() => setSlotsLoading(false));
  }, [date]);

  const handleSubmit = async () => {
    if (!patientName.trim() || !patientPhone.trim() || !reason.trim() || !date || !selectedSlot) {
      setError('Please fill in all fields and select a time slot.');
      return;
    }

    setSubmitting(true);
    setError('');

    try {
      const res = await api.post<BookResponse>('/dashboard/appointments', {
        patientName: patientName.trim(),
        patientPhone: patientPhone.trim(),
        date,
        time: selectedSlot,
        reason: reason.trim(),
      });
      onSuccess(res.data.message);
      onClose();
    } catch (err: unknown) {
      console.error(err);
      setError('Failed to book appointment.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-lg p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-blue-600/20 flex items-center justify-center">
              <Plus className="w-4 h-4 text-blue-400" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">New Appointment</h3>
              <p className="text-xs text-gray-400">Book manually — same flow as a phone booking</p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4 mb-5">
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5">Patient name</label>
            <input
              type="text"
              value={patientName}
              onChange={e => setPatientName(e.target.value)}
              placeholder="e.g. Mohan Gupta"
              className="w-full text-sm bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-600 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5">Phone number</label>
            <input
              type="tel"
              value={patientPhone}
              onChange={e => setPatientPhone(e.target.value)}
              placeholder="e.g. 9876543210"
              className="w-full text-sm bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-600 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-xs text-gray-500 mt-1">
              If this number already has a patient record, their name will be updated to match.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5">Reason for visit</label>
            <input
              type="text"
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="e.g. Teeth cleaning"
              className="w-full text-sm bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-600 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5">Date</label>
            <input
              type="date"
              value={date}
              min={minDate}
              max={maxDate}
              onChange={e => setDate(e.target.value)}
              className="w-full text-sm bg-gray-800 border border-gray-700 text-gray-100 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-xs text-gray-500 mt-1">Bookings are limited to 7 days in advance.</p>
          </div>

          {date && (
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5">Available slots</label>

              {slotsLoading ? (
                <div className="flex items-center gap-2 text-sm text-gray-500 py-3">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading slots...
                </div>
              ) : slotsError ? (
                <p className="text-sm text-red-400 py-2">{slotsError}</p>
              ) : slots.length === 0 ? (
                <p className="text-sm text-gray-500 py-2">No available slots on this date. Try another day.</p>
              ) : (
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 max-h-48 overflow-y-auto pr-1">
                  {slots.map(slot => (
                    <button
                      key={slot.start}
                      onClick={() => setSelectedSlot(slot.start)}
                      className={`text-xs px-3 py-2 rounded-lg border transition-colors ${
                        selectedSlot === slot.start
                          ? 'bg-blue-600 border-blue-500 text-white'
                          : 'bg-gray-800 border-gray-700 text-gray-300 hover:bg-gray-700'
                      }`}
                    >
                      {slot.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {error && (
          <div className="mb-4 px-3 py-2.5 bg-red-500/10 border border-red-500/20 rounded-lg">
            <p className="text-xs text-red-400">{error}</p>
          </div>
        )}

        <div className="mb-5 px-3 py-2.5 bg-blue-500/10 border border-blue-500/20 rounded-lg">
          <p className="text-xs text-blue-300">
            The patient will receive a booking confirmation SMS, a reminder call 1 hour before the
            appointment, and a feedback SMS 1 hour after — same as a phone booking with Maya.
          </p>
        </div>

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2.5 text-sm text-gray-300 border border-gray-700 rounded-lg hover:bg-gray-800 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || !selectedSlot}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Booking...</>
              : <><Plus className="w-4 h-4" /> Book Appointment</>
            }
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Reschedule Modal ──────────────────────────────────────────────────────────
interface RescheduleModalProps {
  appointment: Appointment;
  timezone: string;
  onClose: () => void;
  onSuccess: (message: string) => void;
}

function RescheduleModal({ appointment, timezone, onClose, onSuccess }: RescheduleModalProps) {
  const [newDate, setNewDate] = useState('');
  const [newTime, setNewTime] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [minDate] = useState(
  () => new Date().toISOString().split('T')[0]
);

  const handleSubmit = async () => {
    if (!newDate || !newTime) {
      setError('Please select both a date and time');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await api.patch<RescheduleResponse>(
        `/dashboard/appointments/${appointment.id}/reschedule`,
        { newDate, newTime }
      );
      onSuccess(res.data.message);
      onClose();
    } catch (err) {
      console.error(err);
      setError('Failed to reschedule. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-blue-600/20 flex items-center justify-center">
              <CalendarClock className="w-4 h-4 text-blue-400" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">Reschedule Appointment</h3>
              <p className="text-xs text-gray-400">{appointment.patient.name}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="bg-gray-800 rounded-xl p-4 mb-5">
          <p className="text-xs text-gray-500 mb-1">Current appointment</p>
          <p className="text-sm font-medium text-white">{appointment.reason}</p>
          <p className="text-xs text-gray-400 mt-1">{formatDateTime(appointment.startAt, timezone)}</p>
        </div>

        <div className="space-y-4 mb-5">
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5">New date</label>
            <input
              type="date"
              value={newDate}
              min={minDate}
              onChange={e => setNewDate(e.target.value)}
              className="w-full text-sm bg-gray-800 border border-gray-700 text-gray-100 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5">New time</label>
            <input
              type="time"
              value={newTime}
              onChange={e => setNewTime(e.target.value)}
              className="w-full text-sm bg-gray-800 border border-gray-700 text-gray-100 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        {error && (
          <div className="mb-4 px-3 py-2.5 bg-red-500/10 border border-red-500/20 rounded-lg">
            <p className="text-xs text-red-400">{error}</p>
          </div>
        )}

        <div className="mb-5 px-3 py-2.5 bg-blue-500/10 border border-blue-500/20 rounded-lg">
          <p className="text-xs text-blue-300">
            The patient will automatically receive an SMS notification about this reschedule.
          </p>
        </div>

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2.5 text-sm text-gray-300 border border-gray-700 rounded-lg hover:bg-gray-800 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={loading || !newDate || !newTime}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Rescheduling...</>
              : <><CalendarClock className="w-4 h-4" /> Confirm Reschedule</>
            }
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Cancel Confirmation Modal ─────────────────────────────────────────────────
interface CancelModalProps {
  appointment: Appointment;
  timezone: string;
  onClose: () => void;
  onSuccess: (message: string) => void;
}

function CancelModal({ appointment, timezone, onClose, onSuccess }: CancelModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleConfirm = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.patch<CancelResponse>(
        `/dashboard/appointments/${appointment.id}/cancel`
      );
      onSuccess(res.data.message);
      onClose();
    } catch (err) {
      console.error(err);
      setError('Failed to cancel. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-md p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-red-600/20 flex items-center justify-center">
              <Trash2 className="w-4 h-4 text-red-400" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">Cancel Appointment</h3>
              <p className="text-xs text-gray-400">{appointment.patient.name}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="bg-gray-800 rounded-xl p-4 mb-5">
          <p className="text-xs text-gray-500 mb-1">Appointment to cancel</p>
          <p className="text-sm font-medium text-white">{appointment.reason}</p>
          <p className="text-xs text-gray-400 mt-1">{formatDateTime(appointment.startAt, timezone)}</p>
        </div>

        <div className="mb-5 px-3 py-2.5 bg-red-500/10 border border-red-500/20 rounded-lg">
          <p className="text-xs text-red-300">
            This will cancel the appointment and remove it from Google Calendar. The patient will be notified via SMS.
          </p>
        </div>

        {error && (
          <div className="mb-4 px-3 py-2.5 bg-red-500/10 border border-red-500/20 rounded-lg">
            <p className="text-xs text-red-400">{error}</p>
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2.5 text-sm text-gray-300 border border-gray-700 rounded-lg hover:bg-gray-800 transition-colors"
          >
            Keep appointment
          </button>
          <button
            onClick={handleConfirm}
            disabled={loading}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors disabled:opacity-50"
          >
            {loading
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Cancelling...</>
              : <><Trash2 className="w-4 h-4" /> Yes, Cancel</>
            }
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function AppointmentsPage() {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [total, setTotal] = useState(0);
  const [timezone, setTimezone] = useState('Asia/Kolkata');
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabType>('upcoming');
  const [page, setPage] = useState(1);
  const [rescheduleTarget, setRescheduleTarget] = useState<Appointment | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Appointment | null>(null);
  const [showNewModal, setShowNewModal] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const totalPages = Math.ceil(total / 20);

  const fetchAppointments = useCallback(() => {
  setLoading(true);

  api.get<AppointmentsResponse>('/dashboard/appointments', {
    params: { tab: activeTab, page, limit: 20 },
  })
    .then(r => {
      setAppointments(r.data.appointments);
      setTotal(r.data.total);
      setTimezone(r.data.timezone);
    })
    .catch(console.error)
    .finally(() => setLoading(false));
}, [activeTab, page]);

  useEffect(() => {
  fetchAppointments();
}, [fetchAppointments]);

  const handleSuccess = useCallback((message: string) => {
  setSuccessMessage(message);

  setTimeout(() => {
    setSuccessMessage('');
  }, 5000);

  fetchAppointments();
}, [fetchAppointments]);

  const tabs: { key: TabType; label: string; icon: React.ElementType }[] = [
    { key: 'upcoming', label: 'Upcoming', icon: Clock },
    { key: 'past', label: 'Past', icon: CheckCircle },
    { key: 'cancelled', label: 'Cancelled', icon: XCircle },
  ];

  const showActions = activeTab === 'upcoming';

  return (
    <div className="p-8">
      <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Appointments</h1>
          <p className="text-sm text-gray-400 mt-1">{total} {activeTab} appointments</p>
        </div>

        <button
          onClick={() => setShowNewModal(true)}
          className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors w-full sm:w-auto"
        >
          <Plus className="w-4 h-4" />
          New Appointment
        </button>
      </div>

      {successMessage && (
        <div className="mb-4 px-4 py-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl flex items-center gap-3">
          <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0" />
          <p className="text-sm text-emerald-300">{successMessage}</p>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-5 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit">
        {tabs.map(tab => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              onClick={() => { setActiveTab(tab.key); setPage(1); }}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                activeTab === tab.key
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Table */}
      <div className="bg-gray-900 rounded-xl border border-gray-800">
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : appointments.length === 0 ? (
          <div className="py-20 text-center">
            <Calendar className="w-8 h-8 text-gray-700 mx-auto mb-3" />
            <p className="text-sm text-gray-500">No {activeTab} appointments</p>
          </div>
        ) : (
          <>
            <div className={`grid px-6 py-3 border-b border-gray-800 text-xs font-medium text-gray-500 uppercase tracking-wider ${
              showActions ? 'grid-cols-6' : 'grid-cols-5'
            }`}>
              <span>Patient</span>
              <span>Reason</span>
              <span>Date & Time</span>
              <span>Status</span>
              <span>Phone</span>
              {showActions && <span>Actions</span>}
            </div>

            <div className="divide-y divide-gray-800">
              {appointments.map(appt => (
                <div
                  key={appt.id}
                  className={`grid px-6 py-4 hover:bg-gray-800/50 transition-colors items-center ${
                    showActions ? 'grid-cols-6' : 'grid-cols-5'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-blue-600/20 flex items-center justify-center flex-shrink-0">
                      <span className="text-blue-400 text-xs font-semibold">
                        {appt.patient.name.charAt(0).toUpperCase()}
                      </span>
                    </div>
                    <span className="text-sm font-medium text-white truncate">{appt.patient.name}</span>
                  </div>
                  <span className="text-sm text-gray-300 truncate">{appt.reason}</span>
                  <span className="text-sm text-gray-300">{formatDateTime(appt.startAt, timezone)}</span>
                  <StatusBadge status={appt.status} />
                  <span className="text-sm text-gray-400 font-mono">{appt.patient.phone}</span>
                  {showActions && (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setRescheduleTarget(appt)}
                        className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white transition-colors"
                      >
                        <CalendarClock className="w-3.5 h-3.5" />
                        Reschedule
                      </button>
                      <button
                        onClick={() => setCancelTarget(appt)}
                        className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 hover:text-red-300 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {totalPages > 1 && (
              <div className="px-6 py-4 border-t border-gray-800 flex items-center justify-between">
                <span className="text-xs text-gray-500">
                  Page {page} of {totalPages} · {total} records
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={page === 1}
                    className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-300 disabled:opacity-40 hover:bg-gray-800"
                  >
                    <ChevronLeft className="w-3 h-3" /> Previous
                  </button>
                  <button
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    disabled={page === totalPages}
                    className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-300 disabled:opacity-40 hover:bg-gray-800"
                  >
                    Next <ChevronRight className="w-3 h-3" />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {showNewModal && (
        <NewAppointmentModal
          onClose={() => setShowNewModal(false)}
          onSuccess={handleSuccess}
        />
      )}

      {rescheduleTarget && (
        <RescheduleModal
          appointment={rescheduleTarget}
          timezone={timezone}
          onClose={() => setRescheduleTarget(null)}
          onSuccess={handleSuccess}
        />
      )}

      {cancelTarget && (
        <CancelModal
          appointment={cancelTarget}
          timezone={timezone}
          onClose={() => setCancelTarget(null)}
          onSuccess={handleSuccess}
        />
      )}
    </div>
  );
}