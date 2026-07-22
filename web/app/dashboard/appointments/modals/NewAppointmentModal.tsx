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
  X,
  Loader2,
  Plus,
} from 'lucide-react';


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
            <label className="block text-xs font-medium text-gray-400 mb-1.5">Doctor</label>
            <select
              value={selectedDoctorId}
              onChange={e => setSelectedDoctorId(e.target.value)}
              className="w-full text-sm bg-gray-800 border border-gray-700 text-gray-100 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
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
            disabled={
              submitting ||
              !selectedDoctorId ||
              !selectedSlot
            }
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
