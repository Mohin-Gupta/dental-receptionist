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
  appointments: Appointment[];
  timezone: string;
  showActions: boolean;
  onReschedule: (
    appointment: Appointment
  ) => void;
  onCancel: (
    appointment: Appointment
  ) => void;
}

export default function AppointmentTable({
  appointments,
  timezone,
  showActions,
  onReschedule,
  onCancel,
}: Props) {
  return (
    <div className="hidden lg:block">
      <div className="divide-y divide-gray-800">
        {appointments.map((appointment) => (
          <div
            key={appointment.id}
            className={`grid px-6 py-4 hover:bg-gray-800/50 transition-colors items-center ${
              showActions
                ? 'grid-cols-6'
                : 'grid-cols-5'
            }`}
          >
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-blue-600/20 flex items-center justify-center flex-shrink-0">
                <span className="text-blue-400 text-xs font-semibold">
                  {appointment.patient.name
                    .charAt(0)
                    .toUpperCase()}
                </span>
              </div>

              <span className="text-sm font-medium text-white truncate">
                {appointment.patient.name}
              </span>
            </div>

            <span className="text-sm text-gray-300 truncate">
              {appointment.reason}
            </span>

            <span className="text-sm text-gray-300">
              {formatDateTime(
                appointment.startAt,
                timezone
              )}
            </span>

            <StatusBadge
              status={appointment.status}
            />

            <span className="text-sm text-gray-400 font-mono">
              {appointment.patient.phone}
            </span>

            {showActions && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() =>
                    onReschedule(
                      appointment
                    )
                  }
                  className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white transition-colors"
                >
                  <CalendarClock className="w-3.5 h-3.5" />
                  Reschedule
                </button>

                <button
                  onClick={() =>
                    onCancel(
                      appointment
                    )
                  }
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
    </div>
  );
}