'use client';

import { useCallback, useState } from 'react';

import { Appointment } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { CalendarDays, Plus } from 'lucide-react';
import PageHeader from '@/components/ui/PageHeader';

import useAppointments from './hooks/useAppointments';

import AppointmentTabs from './components/AppointmentTabs';
import AppointmentTable from './components/AppointmentTable';
import AppointmentCard from './components/AppointmentCard';
import Pagination from '../shared/components/Pagination';
import SuccessAlert from './components/SuccessAlert';

import NewAppointmentModal from './modals/NewAppointmentModal';
import RescheduleModal from './modals/RescheduleModal';
import CancelModal from './modals/CancelModal';

export default function AppointmentsPage() {
  const { canWriteAppointments } = useAuth();
  const {
    appointments,
    total,
    timezone,
    loading,
    activeTab,
    setActiveTab,
    page,
    setPage,
    fetchAppointments,
  } = useAppointments();

  const [showNewModal, setShowNewModal] =
    useState(false);

  const [successMessage, setSuccessMessage] =
    useState('');

  const [rescheduleTarget, setRescheduleTarget] =
    useState<Appointment | null>(null);

  const [cancelTarget, setCancelTarget] =
    useState<Appointment | null>(null);

  const totalPages = Math.ceil(total / 20);

  const handleSuccess = useCallback(
    (message: string) => {
      setSuccessMessage(message);

      setTimeout(() => {
        setSuccessMessage('');
      }, 5000);

      fetchAppointments();
    },
    [fetchAppointments]
  );

  const showActions =
    activeTab === 'upcoming' && canWriteAppointments;

  return (
    <div className="page-shell">
      <PageHeader
        eyebrow="Clinical schedule"
        title="Appointments"
        icon={CalendarDays}
        description={
          <>
            <span className="font-semibold text-ink-soft">{total}</span>{' '}
            {activeTab} appointments in this clinic
          </>
        }
        actions={canWriteAppointments ? (
          <button
            type="button"
            onClick={() => setShowNewModal(true)}
            className="btn-primary w-full sm:w-auto"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            New Appointment
          </button>
        ) : undefined}
      />

      <SuccessAlert
        message={successMessage}
      />

      <AppointmentTabs
        activeTab={activeTab}
        onChange={(tab) => {
          setActiveTab(tab);
          setPage(1);
        }}
      />

      <section className="surface-card overflow-hidden" aria-label={`${activeTab} appointments`}>
        {loading ? (
          <div className="space-y-1 p-4 sm:p-5" role="status" aria-label="Loading appointments">
            {[0, 1, 2, 3].map((row) => (
              <div key={row} className="flex items-center gap-4 rounded-xl px-2 py-3">
                <span className="skeleton h-9 w-9 shrink-0 rounded-full" />
                <span className="skeleton h-3.5 w-32" />
                <span className="skeleton ml-auto hidden h-3.5 w-40 sm:block" />
                <span className="skeleton hidden h-6 w-20 lg:block" />
              </div>
            ))}
            <span className="sr-only">Loading appointments</span>
          </div>
        ) : appointments.length === 0 ? (
          <div className="px-5 py-16 text-center sm:py-20">
            <span className="empty-illustration mx-auto">
              <CalendarDays className="h-5 w-5" aria-hidden="true" />
            </span>
            <h2 className="mt-4 text-sm font-bold text-ink">No {activeTab} appointments</h2>
            <p className="mx-auto mt-1.5 max-w-sm text-xs leading-5 text-muted">
              Appointments in this category will appear here as your clinic schedule changes.
            </p>
          </div>
        ) : (
          <>
            <div className="space-y-3 bg-surface-subtle p-3 sm:p-4 xl:hidden">
              {appointments.map(
                (appointment) => (
                  <AppointmentCard
                    key={appointment.id}
                    appointment={
                      appointment
                    }
                    timezone={timezone}
                    showActions={
                      showActions
                    }
                    onReschedule={
                      setRescheduleTarget
                    }
                    onCancel={
                      setCancelTarget
                    }
                  />
                )
              )}
            </div>

            <AppointmentTable
              appointments={
                appointments
              }
              timezone={timezone}
              showActions={
                showActions
              }
              onReschedule={
                setRescheduleTarget
              }
              onCancel={
                setCancelTarget
              }
            />

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

      {showNewModal && (
        <NewAppointmentModal
          onClose={() =>
            setShowNewModal(false)
          }
          onSuccess={handleSuccess}
        />
      )}

      {rescheduleTarget && (
        <RescheduleModal
          appointment={
            rescheduleTarget
          }
          timezone={timezone}
          onClose={() =>
            setRescheduleTarget(
              null
            )
          }
          onSuccess={handleSuccess}
        />
      )}

      {cancelTarget && (
        <CancelModal
          appointment={cancelTarget}
          timezone={timezone}
          onClose={() =>
            setCancelTarget(null)
          }
          onSuccess={handleSuccess}
        />
      )}
    </div>
  );
}
