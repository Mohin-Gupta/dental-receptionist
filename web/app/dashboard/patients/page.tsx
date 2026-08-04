'use client';

import { Users } from 'lucide-react';
import PageHeader from '@/components/ui/PageHeader';

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
    <div className="page-shell">
      <PageHeader
        eyebrow="Patient directory"
        title="Patients"
        icon={Users}
        description={
          <>
            <span className="font-semibold text-ink-soft">{total}</span> registered patients across this clinic
          </>
        }
        actions={(
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
        )}
      />

      <section className="surface-card overflow-hidden" aria-label="Patient directory">
        {loading ? (
          <div className="space-y-1 p-4 sm:p-5" role="status" aria-label="Loading patients">
            {[0, 1, 2, 3].map((row) => (
              <div key={row} className="flex items-center gap-4 rounded-xl px-2 py-3">
                <span className="skeleton h-10 w-10 shrink-0 rounded-full" />
                <span className="skeleton h-3.5 w-36" />
                <span className="skeleton ml-auto hidden h-3.5 w-28 sm:block" />
                <span className="skeleton hidden h-7 w-20 md:block" />
              </div>
            ))}
            <span className="sr-only">Loading patients</span>
          </div>
        ) : patients.length === 0 ? (
          <div className="px-5 py-16 text-center sm:py-20">
            <span className="empty-illustration mx-auto">
              <Users className="h-5 w-5" aria-hidden="true" />
            </span>
            <h2 className="mt-4 text-sm font-bold text-ink">No patients found</h2>
            <p className="mx-auto mt-1.5 max-w-sm text-xs leading-5 text-muted">
              {search.trim()
                ? 'Try a different patient name or phone number.'
                : 'Patient profiles will appear here after their first booking.'}
            </p>
          </div>
        ) : (
          <>
            {/* Desktop Table */}

            <PatientTable
              patients={patients}
            />

            <div className="space-y-3 bg-surface-subtle p-3 sm:p-4 xl:hidden">
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
      </section>
    </div>
  );
}
