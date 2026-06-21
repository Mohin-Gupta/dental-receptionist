'use client';

import { useState } from 'react';

import api, {
  Appointment,
  CancelResponse,
  formatDateTime,
} from '@/lib/api';

import {
  Loader2,
  Trash2,
  X,
} from 'lucide-react';

interface CancelModalProps {
  appointment: Appointment;
  timezone: string;
  onClose: () => void;
  onSuccess: (message: string) => void;
}

export default function CancelModal({ appointment, timezone, onClose, onSuccess }: CancelModalProps) {
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