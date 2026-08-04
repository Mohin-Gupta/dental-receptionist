import {
  Appointment,
  formatDateTime,
} from '@/lib/api';

import {
  CalendarDays,
  CalendarClock,
  Phone,
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
    <article className="rounded-[1rem] border border-line bg-white p-4 shadow-[0_6px_22px_rgba(19,43,35,0.045)]">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="avatar h-10 w-10 text-sm">
            {appointment.patient.name.charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-bold text-ink">
              {appointment.patient.name}
            </h3>
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted">
            {appointment.reason}
            </p>
          </div>
        </div>

        <StatusBadge
          status={appointment.status}
        />
      </div>

      <div className="mt-4 grid gap-2.5 rounded-xl bg-surface-subtle p-3 sm:grid-cols-2">
        <div className="flex items-start gap-2.5">
          <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
          <div>
            <p className="text-[0.64rem] font-bold uppercase tracking-[0.1em] text-muted">Appointment</p>
            <p className="mt-1 text-xs font-semibold leading-5 text-ink-soft">
            {formatDateTime(
              appointment.startAt,
              timezone
            )}
            </p>
          </div>
        </div>

        <div className="flex items-start gap-2.5">
          <Phone className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
          <div>
            <p className="text-[0.64rem] font-bold uppercase tracking-[0.1em] text-muted">Phone</p>
            <p className="mt-1 text-xs font-semibold text-ink-soft">
            {appointment.patient.phone}
            </p>
          </div>
        </div>
      </div>

      {showActions && (
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() =>
              onReschedule(appointment)
            }
            className="btn-secondary min-h-10 px-3"
          >
            <CalendarClock className="w-4 h-4" />
            Reschedule
          </button>

          <button
            type="button"
            onClick={() =>
              onCancel(appointment)
            }
            className="btn-danger-soft min-h-10 px-3"
          >
            <Trash2 className="w-4 h-4" />
            Cancel
          </button>
        </div>
      )}
    </article>
  );
}
