'use client';

import { Users } from 'lucide-react';

import usePatients from './hooks/usePatients';

import PatientSearch from './components/PatientSearch';
import PatientTable from './components/PatientTable';
import PatientCard from './components/PatientCard';

import Pagination from '../shared/components/Pagination';

export default function PatientsPage() {
  const {
    patients,
    total,

    search,
    setSearch,

    page,
    setPage,

    loading,
    setLoading,
  } = usePatients();

  const totalPages = Math.ceil(total / 20);

  return (
    <div className="p-4 md:p-6 lg:p-8">
      <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">
            Patients
          </h1>

          <p className="text-sm text-gray-400 mt-1">
            {total} registered patients
          </p>
        </div>

        <PatientSearch
          value={search}
          onChange={(value) => {
            setSearch(value);
            setPage(1);
          }}
          onSearchStart={() =>
            setLoading(true)
          }
        />
      </div>

      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : patients.length === 0 ? (
          <div className="py-20 text-center">
            <Users className="w-8 h-8 text-gray-700 mx-auto mb-3" />

            <p className="text-sm text-gray-500">
              No patients found
            </p>
          </div>
        ) : (
          <>
            {/* Desktop Table */}

            <PatientTable
              patients={patients}
            />

            {/* Mobile Cards */}

            <div className="md:hidden divide-y divide-gray-800">
              {patients.map(
                (patient) => (
                  <PatientCard
                    key={patient.id}
                    patient={
                      patient
                    }
                  />
                )
              )}
            </div>

            <Pagination
              page={page}
              totalPages={totalPages}
              total={total}
              onPrevious={() =>
                setPage((p) =>
                  Math.max(1, p - 1)
                )
              }
              onNext={() =>
                setPage((p) =>
                  Math.min(
                    totalPages,
                    p + 1
                  )
                )
              }
            />
          </>
        )}
      </div>
    </div>
  );
}