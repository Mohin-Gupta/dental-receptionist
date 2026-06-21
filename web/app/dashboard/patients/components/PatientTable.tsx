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
    <div className="hidden md:block">
      <div className="grid grid-cols-5 px-6 py-3 border-b border-gray-800 text-xs font-medium text-gray-500 uppercase tracking-wider">
        <span className="col-span-2">
          Patient
        </span>

        <span>Phone</span>

        <span>Total Visits</span>

        <span>Last Visit</span>
      </div>

      <div className="divide-y divide-gray-800">
        {patients.map(
          (patient) => (
            <div
              key={
                patient.id
              }
              className="grid grid-cols-5 px-6 py-4 hover:bg-gray-800/50 transition-colors items-center"
            >
              <div className="col-span-2 flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-purple-600/20 flex items-center justify-center">
                  <span className="text-purple-400 text-sm font-semibold">
                    {getInitial(
                      patient.name
                    )}
                  </span>
                </div>

                <div>
                  <p className="text-sm font-medium text-white">
                    {
                      patient.name
                    }
                  </p>

                  <p className="text-xs text-gray-500">
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

              <span className="text-sm text-gray-300 font-mono">
                {
                  patient.phone
                }
              </span>

              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-white">
                  {
                    patient
                      ._count
                      .appointments
                  }
                </span>

                <span className="text-xs text-gray-500">
                  visits
                </span>
              </div>

              <span className="text-sm text-gray-400">
                {getLastVisit(
                  patient
                    .appointments[0]
                    ?.startAt
                )}
              </span>
            </div>
          )
        )}
      </div>
    </div>
  );
}