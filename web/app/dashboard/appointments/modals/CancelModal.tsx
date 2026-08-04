'use client';

import { useRef, useState } from 'react';

import api, {
  Appointment,
  CancelResponse,
  formatDateTime,
} from '@/lib/api';

import {
  AlertTriangle,
  CalendarDays,
  Loader2,
  Trash2,
  X,
} from 'lucide-react';
import useModalBehavior from './useModalBehavior';

interface CancelModalProps {
  appointment: Appointment;
  timezone: string;
  onClose: () => void;
  onSuccess: (message: string) => void;
}

export default function CancelModal({ appointment, timezone, onClose, onSuccess }: CancelModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const keepAppointmentRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalBehavior(onClose, keepAppointmentRef);

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
    <div className="modal-backdrop" role="presentation">
      <div
        ref={dialogRef}
        className="modal-panel max-w-md"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cancel-appointment-title"
        aria-describedby="cancel-appointment-description"
        tabIndex={-1}
      >
        <header className="modal-header">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#efd0cc] bg-danger-soft text-danger">
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </span>
            <div>
              <p className="section-kicker mb-1">Schedule change</p>
              <h2 id="cancel-appointment-title" className="section-title">Cancel appointment</h2>
              <p className="section-description mt-0.5">{appointment.patient.name}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="icon-button" aria-label="Close cancel appointment dialog">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <div className="space-y-4 p-5">
          <div className="surface-card-soft p-4">
            <p className="section-kicker">Appointment to cancel</p>
            <p className="mt-2 text-sm font-bold text-ink">{appointment.reason}</p>
            <p className="mt-2 flex items-center gap-2 text-xs font-medium text-muted">
              <CalendarDays className="h-3.5 w-3.5 text-brand" aria-hidden="true" />
              {formatDateTime(appointment.startAt, timezone)}
            </p>
          </div>

          <div className="alert-warning" id="cancel-appointment-description">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p>
            This will cancel the appointment and remove it from Google Calendar. The patient will be notified via SMS.
            </p>
          </div>

          {error && (
            <div className="alert-error" role="alert">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <p>{error}</p>
            </div>
          )}
        </div>

        <footer className="modal-footer">
          <button
            ref={keepAppointmentRef}
            type="button"
            onClick={onClose}
            className="btn-secondary flex-1"
          >
            Keep appointment
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={loading}
            className="btn-danger flex-1"
          >
            {loading
              ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Cancelling...</>
              : <><Trash2 className="h-4 w-4" aria-hidden="true" /> Yes, Cancel</>
            }
          </button>
        </footer>
      </div>
    </div>
  );
}
