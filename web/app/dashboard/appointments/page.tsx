'use client';

import { useCallback, useState } from 'react';

import { Appointment } from '@/lib/api';
import { Calendar, Plus } from 'lucide-react';

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
    activeTab === 'upcoming';

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">
            Appointments
          </h1>

          <p className="text-sm text-gray-400 mt-1">
            {total} {activeTab} appointments
          </p>
        </div>

        <button
          onClick={() =>
            setShowNewModal(true)
          }
          className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors w-full sm:w-auto"
        >
          <Plus className="w-4 h-4" />
          New Appointment
        </button>
      </div>

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

      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : appointments.length === 0 ? (
          <div className="py-20 text-center">
            <Calendar className="w-8 h-8 text-gray-700 mx-auto mb-3" />

            <p className="text-sm text-gray-500">
              No {activeTab} appointments
            </p>
          </div>
        ) : (
          <>
            <div className="lg:hidden p-4 space-y-3">
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

            <div
              className={`hidden lg:grid px-6 py-3 border-b border-gray-800 text-xs font-medium text-gray-500 uppercase tracking-wider ${
                showActions
                  ? 'grid-cols-6'
                  : 'grid-cols-5'
              }`}
            >
              <span>Patient</span>
              <span>Reason</span>
              <span>Date & Time</span>
              <span>Status</span>
              <span>Phone</span>

              {showActions && (
                <span>Actions</span>
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
      </div>

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