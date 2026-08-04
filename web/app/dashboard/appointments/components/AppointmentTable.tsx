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
    <div className="hidden max-w-full overflow-x-auto xl:block">
      <table className="w-full min-w-[920px] table-fixed border-collapse text-left">
        <colgroup>
          <col style={{ width: showActions ? '20%' : '23%' }} />
          <col style={{ width: showActions ? '15%' : '24%' }} />
          <col style={{ width: showActions ? '17%' : '22%' }} />
          <col style={{ width: showActions ? '10%' : '14%' }} />
          <col style={{ width: showActions ? '14%' : '17%' }} />
          {showActions && <col style={{ width: '24%' }} />}
        </colgroup>
        <thead className="data-header">
          <tr>
            <th scope="col" className="px-6 py-3.5">Patient</th>
            <th scope="col" className="px-4 py-3.5">Reason</th>
            <th scope="col" className="px-4 py-3.5">Date &amp; time</th>
            <th scope="col" className="px-4 py-3.5">Status</th>
            <th scope="col" className="px-4 py-3.5">Phone</th>
            {showActions && (
              <th scope="col" className="px-6 py-3.5 text-right">Actions</th>
            )}
          </tr>
        </thead>

        <tbody>
          {appointments.map((appointment) => (
            <tr key={appointment.id} className="data-row">
              <th scope="row" className="px-6 py-4 font-normal">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="avatar h-9 w-9 text-xs">
                    {appointment.patient.name.charAt(0).toUpperCase()}
                  </span>
                  <span className="max-w-[13rem] truncate text-[0.82rem] font-bold text-ink">
                    {appointment.patient.name}
                  </span>
                </div>
              </th>

              <td className="max-w-[17rem] px-4 py-4">
                <p className="truncate text-[0.8rem] font-medium text-ink-soft" title={appointment.reason}>
                  {appointment.reason}
                </p>
              </td>

              <td className="px-4 py-4 text-[0.78rem] font-medium leading-5 text-ink-soft">
                {formatDateTime(appointment.startAt, timezone)}
              </td>

              <td className="px-4 py-4">
                <StatusBadge status={appointment.status} />
              </td>

              <td className="overflow-hidden px-4 py-4 font-mono text-[0.76rem] text-muted">
                <span className="block truncate">{appointment.patient.phone}</span>
              </td>

              {showActions && (
                <td className="px-6 py-4">
                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => onReschedule(appointment)}
                      className="btn-secondary btn-compact"
                    >
                      <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
                      Reschedule
                    </button>

                    <button
                      type="button"
                      onClick={() => onCancel(appointment)}
                      className="btn-danger-soft btn-compact"
                      aria-label={`Cancel appointment for ${appointment.patient.name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      Cancel
                    </button>
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
