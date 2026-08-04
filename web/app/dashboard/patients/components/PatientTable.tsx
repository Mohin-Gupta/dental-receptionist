import { PatientWithStats } from '@/lib/api';

import { format } from 'date-fns';

import {
  getInitial,
  getLastVisit,
} from '../utils/patientHelpers';

interface Props {
  patients: PatientWithStats[];
}

export default function PatientTable({
  patients,
}: Props) {
  return (
    <div className="hidden max-w-full overflow-x-auto xl:block">
      <table className="w-full min-w-[720px] table-fixed border-collapse text-left">
        <colgroup>
          <col style={{ width: '38%' }} />
          <col style={{ width: '24%' }} />
          <col style={{ width: '18%' }} />
          <col style={{ width: '20%' }} />
        </colgroup>
        <thead className="data-header">
          <tr>
            <th scope="col" className="px-6 py-3.5">Patient</th>
            <th scope="col" className="px-4 py-3.5">Phone</th>
            <th scope="col" className="px-4 py-3.5">Total visits</th>
            <th scope="col" className="px-6 py-3.5">Last visit</th>
          </tr>
        </thead>

        <tbody>
        {patients.map(
          (patient) => (
            <tr key={patient.id} className="data-row">
              <th scope="row" className="px-6 py-4 font-normal">
                <div className="flex items-center gap-3">
                  <span className="avatar h-10 w-10 text-sm">
                    {getInitial(
                      patient.name
                    )}
                  </span>

                  <div className="min-w-0">
                    <p className="truncate text-[0.82rem] font-bold text-ink">
                      {patient.name}
                    </p>

                    <p className="mt-1 text-[0.66rem] font-medium text-muted">
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
              </th>

              <td className="overflow-hidden px-4 py-4 font-mono text-[0.76rem] text-ink-soft">
                <span className="block truncate">{patient.phone}</span>
              </td>

              <td className="px-4 py-4">
                <div className="inline-flex items-baseline gap-1.5 rounded-lg bg-brand-softer px-2.5 py-1.5">
                  <span className="text-sm font-bold text-brand-dark">
                  {
                    patient
                      ._count
                      .appointments
                  }
                </span>

                  <span className="text-[0.65rem] font-semibold text-muted">
                  visits
                  </span>
                </div>
              </td>

              <td className="px-6 py-4 text-[0.78rem] font-medium text-muted">
                {getLastVisit(
                  patient
                    .appointments[0]
                    ?.startAt
                )}
              </td>
            </tr>
          )
        )}
        </tbody>
      </table>
    </div>
  );
}
