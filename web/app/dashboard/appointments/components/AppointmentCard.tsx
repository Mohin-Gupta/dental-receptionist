import {
  Appointment,
  formatDateTime,
} from '@/lib/api';

import {
  CalendarClock,
  Trash2,
} from 'lucide-react';

import StatusBadge from './StatusBadge';

interface Props {
  appointment: Appointment;
  timezone: string;
  showActions: boolean;
  onReschedule: (
    appointment: Appointment
  ) => void;
  onCancel: (
    appointment: Appointment
  ) => void;
}

export default function AppointmentCard({
  appointment,
  timezone,
  showActions,
  onReschedule,
  onCancel,
}: Props) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-medium text-white truncate">
            {appointment.patient.name}
          </h3>

          <p className="text-sm text-gray-400 mt-1 break-words">
            {appointment.reason}
          </p>
        </div>

        <StatusBadge
          status={appointment.status}
        />
      </div>

      <div className="mt-4 space-y-2">
        <div>
          <p className="text-xs text-gray-500">
            Appointment
          </p>

          <p className="text-sm text-gray-300">
            {formatDateTime(
              appointment.startAt,
              timezone
            )}
          </p>
        </div>

        <div>
          <p className="text-xs text-gray-500">
            Phone
          </p>

          <p className="text-sm text-gray-400">
            {appointment.patient.phone}
          </p>
        </div>
      </div>

      {showActions && (
        <div className="grid grid-cols-2 gap-2 mt-4">
          <button
            onClick={() =>
              onReschedule(appointment)
            }
            className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors"
          >
            <CalendarClock className="w-4 h-4" />
            Reschedule
          </button>

          <button
            onClick={() =>
              onCancel(appointment)
            }
            className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 transition-colors"
          >
            <Trash2 className="w-4 h-4" />
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}