'use client';

import { useState } from 'react';

import api, {
  Appointment,
  RescheduleResponse,
  formatDateTime,
} from '@/lib/api';

import {
  CalendarClock,
  Loader2,
  X,
} from 'lucide-react';

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