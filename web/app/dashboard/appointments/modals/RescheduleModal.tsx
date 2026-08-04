'use client';

import { useRef, useState } from 'react';

import api, {
  Appointment,
  RescheduleResponse,
  formatDateTime,
  createIdempotencyKey,
} from '@/lib/api';

import {
  CalendarDays,
  CalendarClock,
  CircleAlert,
  Info,
  Loader2,
  X,
} from 'lucide-react';
import useModalBehavior from './useModalBehavior';

interface RescheduleModalProps {
  appointment: Appointment;
  timezone: string;
  onClose: () => void;
  onSuccess: (message: string) => void;
}

export default function RescheduleModal({ appointment, timezone, onClose, onSuccess }: RescheduleModalProps) {
  const [newDate, setNewDate] = useState('');
  const [newTime, setNewTime] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const pendingRequest = useRef<{ fingerprint: string; key: string } | null>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const dialogRef = useModalBehavior(onClose, firstFieldRef);

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
      const payload = { newDate, newTime };
      const fingerprint = JSON.stringify(payload);
      if (pendingRequest.current?.fingerprint !== fingerprint) {
        pendingRequest.current = {
          fingerprint,
          key: createIdempotencyKey(`dashboard-appointment-reschedule:${appointment.id}`),
        };
      }
      const res = await api.patch<RescheduleResponse>(
        `/dashboard/appointments/${appointment.id}/reschedule`,
        payload,
        { headers: { 'Idempotency-Key': pendingRequest.current.key } }
      );
      pendingRequest.current = null;
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
    <div className="modal-backdrop" role="presentation">
      <div
        ref={dialogRef}
        className="modal-panel max-w-md"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reschedule-appointment-title"
        aria-describedby="reschedule-appointment-description"
        tabIndex={-1}
      >
        <header className="modal-header">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#d3e6df] bg-brand-softer text-brand">
              <CalendarClock className="h-4 w-4" aria-hidden="true" />
            </span>
            <div>
              <p className="section-kicker mb-1">Update schedule</p>
              <h2 id="reschedule-appointment-title" className="section-title">Reschedule appointment</h2>
              <p id="reschedule-appointment-description" className="section-description mt-0.5">{appointment.patient.name}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="icon-button" aria-label="Close reschedule appointment dialog">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <div className="space-y-5 p-5">
          <div className="surface-card-soft p-4">
            <p className="section-kicker">Current appointment</p>
            <p className="mt-2 text-sm font-bold text-ink">{appointment.reason}</p>
            <p className="mt-2 flex items-center gap-2 text-xs font-medium text-muted">
              <CalendarDays className="h-3.5 w-3.5 text-brand" aria-hidden="true" />
              {formatDateTime(appointment.startAt, timezone)}
            </p>
          </div>

          <div>
            <p className="mb-3 text-xs font-bold text-ink">Choose a new appointment time</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="reschedule-date" className="ui-label">New date</label>
                <input
                  ref={firstFieldRef}
                  id="reschedule-date"
                  type="date"
                  value={newDate}
                  min={minDate}
                  onChange={e => setNewDate(e.target.value)}
                  className="ui-input"
                />
              </div>
              <div>
                <label htmlFor="reschedule-time" className="ui-label">New time</label>
                <input
                  id="reschedule-time"
                  type="time"
                  value={newTime}
                  onChange={e => setNewTime(e.target.value)}
                  className="ui-input"
                />
              </div>
            </div>
          </div>

          {error && (
            <div className="alert-error" role="alert">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <p>{error}</p>
            </div>
          )}

          <div className="alert-info">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p>The patient will automatically receive an SMS notification about this reschedule.</p>
          </div>
        </div>

        <footer className="modal-footer">
          <button
            type="button"
            onClick={onClose}
            className="btn-secondary flex-1"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={loading || !newDate || !newTime}
            className="btn-primary flex-1"
          >
            {loading
              ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Rescheduling...</>
              : <><CalendarClock className="h-4 w-4" aria-hidden="true" /> Confirm Reschedule</>
            }
          </button>
        </footer>
      </div>
    </div>
  );
}
