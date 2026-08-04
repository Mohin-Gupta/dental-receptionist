import { PatientWithStats } from '@/lib/api';

import { format } from 'date-fns';
import { CalendarClock, Phone, Sparkles } from 'lucide-react';

import {
  getInitial,
  getLastVisit,
} from '../utils/patientHelpers';

interface Props {
  patient: PatientWithStats;
}

export default function PatientCard({
  patient,
}: Props) {
  return (
    <article className="rounded-[1rem] border border-line bg-white p-4 shadow-[0_6px_22px_rgba(19,43,35,0.045)]">
      <div className="flex items-center gap-3">
        <span className="avatar h-11 w-11 text-sm">
            {getInitial(
              patient.name
            )}
        </span>

        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-ink">
            {patient.name}
          </p>

          <p className="mt-1 text-[0.68rem] font-medium text-muted">
            Since{' '}
            {format(
              new Date(
                patient.createdAt
              ),
              'MMM yyyy'
            )}
          </p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2.5">
        <div className="rounded-xl bg-surface-subtle p-3">
          <p className="flex items-center gap-1.5 text-[0.62rem] font-bold uppercase tracking-[0.09em] text-muted">
            <Phone className="h-3.5 w-3.5 text-brand" aria-hidden="true" /> Phone
          </p>
          <p className="mt-1.5 break-all font-mono text-xs font-medium text-ink-soft">
            {patient.phone}
          </p>
        </div>

        <div className="rounded-xl bg-surface-subtle p-3">
          <p className="flex items-center gap-1.5 text-[0.62rem] font-bold uppercase tracking-[0.09em] text-muted">
            <Sparkles className="h-3.5 w-3.5 text-brand" aria-hidden="true" /> Visits
          </p>
          <p className="mt-1.5 text-xs font-bold text-ink">
            {
              patient._count
                .appointments
            } total
          </p>
        </div>

        <div className="col-span-2 rounded-xl border border-line bg-white p-3">
          <p className="flex items-center gap-1.5 text-[0.62rem] font-bold uppercase tracking-[0.09em] text-muted">
            <CalendarClock className="h-3.5 w-3.5 text-brand" aria-hidden="true" /> Last visit
          </p>
          <p className="mt-1.5 text-xs font-semibold text-ink-soft">
            {getLastVisit(
              patient
                .appointments[0]
                ?.startAt
            )}
          </p>
        </div>
      </div>
    </article>
  );
}
