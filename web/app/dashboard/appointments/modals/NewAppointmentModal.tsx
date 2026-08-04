'use client';

import { useEffect, useRef, useState } from 'react';

import api, {
  BookResponse,
  AvailableSlot,
  AvailableSlotsResponse,
  Doctor,
  DoctorsResponse,
  createIdempotencyKey,
} from '@/lib/api';

import {
  CalendarDays,
  CircleAlert,
  Clock3,
  Info,
  X,
  Loader2,
  Plus,
  Stethoscope,
  UserRound,
} from 'lucide-react';
import useModalBehavior from './useModalBehavior';


interface NewAppointmentModalProps {
  onClose: () => void;
  onSuccess: (message: string) => void;
}

export default function NewAppointmentModal({ onClose, onSuccess }: NewAppointmentModalProps) {
  const [patientName, setPatientName] = useState('');
  const [patientPhone, setPatientPhone] = useState('');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState('');
  const [doctors, setDoctors] =
    useState<Doctor[]>([]);
  const [
    selectedDoctorId,
    setSelectedDoctorId,
  ] = useState('');
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);

  const [slots, setSlots] = useState<AvailableSlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const pendingRequest = useRef<{ fingerprint: string; key: string } | null>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const dialogRef = useModalBehavior(onClose, firstFieldRef);

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

  useEffect(() => {
    api
      .get<DoctorsResponse>(
        '/dashboard/doctors'
      )
      .then((response) => {
        setDoctors(
          response.data.doctors
        );

        const firstDoctor =
          response.data.doctors[0];

        if (firstDoctor) {
          setSelectedDoctorId(
            firstDoctor.id
          );
        }
      })
      .catch(() =>
        setError(
          'Failed to load doctors.'
        )
      );
  }, []);

  // Fetch available slots whenever the date changes — same logic Maya uses on calls
  useEffect(() => {
    if (!date || !selectedDoctorId) {
      setSlots([]);
      setSelectedSlot(null);
      return;
    }

    setSlotsLoading(true);
    setSlotsError('');
    setSelectedSlot(null);

    api.get<AvailableSlotsResponse>('/dashboard/available-slots', { params: { date, doctorId: selectedDoctorId } })
      .then(r => setSlots(r.data.slots))
      .catch(() => setSlotsError('Failed to load available slots for this date.'))
      .finally(() => setSlotsLoading(false));
  }, [date, selectedDoctorId]);

  const handleSubmit = async () => {
    if (!patientName.trim() || !patientPhone.trim() || !reason.trim() || !date || !selectedDoctorId || !selectedSlot) {
      setError('Please fill in all fields and select a doctor and time slot.');
      return;
    }

    setSubmitting(true);
    setError('');

    try {
      const payload = {
        patientName: patientName.trim(),
        patientPhone: patientPhone.trim(),
        doctorId: selectedDoctorId,
        date,
        time: selectedSlot,
        reason: reason.trim(),
      };
      const fingerprint = JSON.stringify(payload);
      if (pendingRequest.current?.fingerprint !== fingerprint) {
        pendingRequest.current = {
          fingerprint,
          key: createIdempotencyKey('dashboard-appointment-create'),
        };
      }
      const res = await api.post<BookResponse>('/dashboard/appointments', payload, {
        headers: { 'Idempotency-Key': pendingRequest.current.key },
      });
      pendingRequest.current = null;
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
    <div className="modal-backdrop" role="presentation">
      <div
        ref={dialogRef}
        className="modal-panel max-w-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-appointment-title"
        aria-describedby="new-appointment-description"
        tabIndex={-1}
      >
        <header className="modal-header">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#d3e6df] bg-brand-softer text-brand">
              <Plus className="h-4 w-4" aria-hidden="true" />
            </span>
            <div>
              <p className="section-kicker mb-1">Manual booking</p>
              <h2 id="new-appointment-title" className="section-title">New appointment</h2>
              <p id="new-appointment-description" className="section-description mt-0.5">Book manually — same flow as a phone booking</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="icon-button" aria-label="Close new appointment dialog">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <div className="space-y-4 p-4 sm:p-5">
          <section className="surface-card-soft p-4">
            <div className="mb-4 flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-soft text-brand-dark">
                <UserRound className="h-4 w-4" aria-hidden="true" />
              </span>
              <div>
                <h3 className="text-xs font-bold text-ink">Patient details</h3>
                <p className="mt-0.5 text-[0.68rem] text-muted">Who is this appointment for?</p>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="appointment-patient-name" className="ui-label">Patient name</label>
                <input
                  ref={firstFieldRef}
                  id="appointment-patient-name"
                  type="text"
                  value={patientName}
                  onChange={e => setPatientName(e.target.value)}
                  placeholder="e.g. Mohan Gupta"
                  className="ui-input"
                />
              </div>

              <div>
                <label htmlFor="appointment-patient-phone" className="ui-label">Phone number</label>
                <input
                  id="appointment-patient-phone"
                  type="tel"
                  value={patientPhone}
                  onChange={e => setPatientPhone(e.target.value)}
                  placeholder="e.g. 9876543210"
                  className="ui-input"
                />
                <p className="ui-help">
                  If this number already has a patient record, their name will be updated to match.
                </p>
              </div>
            </div>
          </section>

          <section className="surface-card-soft p-4">
            <div className="mb-4 flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-soft text-brand-dark">
                <Stethoscope className="h-4 w-4" aria-hidden="true" />
              </span>
              <div>
                <h3 className="text-xs font-bold text-ink">Visit details</h3>
                <p className="mt-0.5 text-[0.68rem] text-muted">Add the care context and treating doctor.</p>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="appointment-reason" className="ui-label">Reason for visit</label>
                <input
                  id="appointment-reason"
                  type="text"
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  placeholder="e.g. Teeth cleaning"
                  className="ui-input"
                />
              </div>

              <div>
                <label htmlFor="appointment-doctor" className="ui-label">Doctor</label>
                <select
                  id="appointment-doctor"
                  value={selectedDoctorId}
                  onChange={e => setSelectedDoctorId(e.target.value)}
                  className="ui-select"
                >
                  {doctors.length === 0 ? (
                    <option value="">No doctors available</option>
                  ) : (
                    doctors.map((doctor) => (
                      <option key={doctor.id} value={doctor.id}>
                        {doctor.name}
                      </option>
                    ))
                  )}
                </select>
              </div>
            </div>
          </section>

          <section className="surface-card-soft p-4">
            <div className="mb-4 flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-soft text-brand-dark">
                <CalendarDays className="h-4 w-4" aria-hidden="true" />
              </span>
              <div>
                <h3 className="text-xs font-bold text-ink">Schedule</h3>
                <p className="mt-0.5 text-[0.68rem] text-muted">Choose an available date and time.</p>
              </div>
            </div>

            <div className="max-w-xs">
              <label htmlFor="appointment-date" className="ui-label">Date</label>
              <input
                id="appointment-date"
                type="date"
                value={date}
                min={minDate}
                max={maxDate}
                onChange={e => setDate(e.target.value)}
                className="ui-input"
              />
              <p className="ui-help">Bookings are limited to 7 days in advance.</p>
            </div>

            {date && (
              <div className="mt-4 border-t border-line pt-4">
                <p className="ui-label">Available slots</p>

                {slotsLoading ? (
                  <div className="flex items-center gap-2 py-3 text-xs font-medium text-muted" role="status">
                    <Loader2 className="h-4 w-4 animate-spin text-brand" aria-hidden="true" /> Loading slots...
                  </div>
                ) : slotsError ? (
                  <div className="alert-error" role="alert">
                    <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <p>{slotsError}</p>
                  </div>
                ) : slots.length === 0 ? (
                  <div className="flex items-center gap-2 rounded-xl border border-line bg-white px-3 py-3 text-xs text-muted">
                    <Clock3 className="h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
                    No available slots on this date. Try another day.
                  </div>
                ) : (
                  <div className="grid max-h-48 grid-cols-3 gap-2 overflow-y-auto pr-1 sm:grid-cols-4" role="group" aria-label="Available appointment times">
                    {slots.map(slot => (
                      <button
                        type="button"
                        key={slot.start}
                        aria-pressed={selectedSlot === slot.start}
                        onClick={() => setSelectedSlot(slot.start)}
                        className={`min-h-10 rounded-xl border px-3 py-2 text-xs font-bold transition-colors ${
                          selectedSlot === slot.start
                            ? 'border-brand bg-brand text-white shadow-[0_5px_14px_rgba(19,114,103,0.18)]'
                            : 'border-line-strong bg-white text-ink-soft hover:border-brand hover:bg-brand-softer hover:text-brand-dark'
                        }`}
                      >
                        {slot.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>

          {error && (
            <div className="alert-error" role="alert">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <p>{error}</p>
            </div>
          )}

          <div className="alert-info">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p>
              The patient will receive a booking confirmation SMS, a reminder call 1 hour before the
              appointment, and a feedback SMS 1 hour after — same as a phone booking with Maya.
            </p>
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
            disabled={
              submitting ||
              !selectedDoctorId ||
              !selectedSlot
            }
            className="btn-primary flex-1"
          >
            {submitting
              ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Booking...</>
              : <><Plus className="h-4 w-4" aria-hidden="true" /> Book Appointment</>
            }
          </button>
        </footer>
      </div>
    </div>
  );
}
