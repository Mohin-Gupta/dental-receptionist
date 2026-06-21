import { PatientWithStats } from '@/lib/api';

import { format } from 'date-fns';

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
    <div className="p-4">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-full bg-purple-600/20 flex items-center justify-center">
          <span className="text-purple-400 font-semibold">
            {getInitial(
              patient.name
            )}
          </span>
        </div>

        <div>
          <p className="text-white font-medium">
            {patient.name}
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

      <div className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <p className="text-xs text-gray-500 mb-1">
            Phone
          </p>

          <p className="text-gray-300">
            {patient.phone}
          </p>
        </div>

        <div>
          <p className="text-xs text-gray-500 mb-1">
            Visits
          </p>

          <p className="text-gray-300">
            {
              patient._count
                .appointments
            }
          </p>
        </div>

        <div className="col-span-2">
          <p className="text-xs text-gray-500 mb-1">
            Last Visit
          </p>

          <p className="text-gray-300">
            {getLastVisit(
              patient
                .appointments[0]
                ?.startAt
            )}
          </p>
        </div>
      </div>
    </div>
  );
}