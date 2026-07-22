import { useCallback, useEffect, useState } from 'react';
import api, {
  Appointment,
  AppointmentsResponse,
} from '@/lib/api';
import { useAuth } from '@/lib/auth';

export type TabType =
  | 'upcoming'
  | 'past'
  | 'cancelled';

export default function useAppointments() {
  const {
    activeOrganizationId,
    activeClinicId,
  } = useAuth();

  const [appointments, setAppointments] =
    useState<Appointment[]>([]);

  const [total, setTotal] = useState(0);

  const [timezone, setTimezone] =
    useState('Asia/Kolkata');

  const [loading, setLoading] =
    useState(true);

  const [activeTab, setActiveTab] =
    useState<TabType>('upcoming');

  const [page, setPage] = useState(1);

  const fetchAppointments =
    useCallback(() => {
      setLoading(true);

      api
        .get<AppointmentsResponse>(
          '/dashboard/appointments',
          {
            params: {
              tab: activeTab,
              page,
              limit: 20,
            },
            headers: {
              ...(activeOrganizationId ? { 'X-Organization-Id': activeOrganizationId } : {}),
              ...(activeClinicId ? { 'X-Clinic-Id': activeClinicId } : {}),
            },
          }
        )
        .then((response) => {
          setAppointments(
            response.data.appointments
          );

          setTotal(response.data.total);

          setTimezone(
            response.data.timezone
          );
        })
        .catch(console.error)
        .finally(() => {
          setLoading(false);
        });
    }, [
      activeTab,
      activeClinicId,
      activeOrganizationId,
      page,
    ]);

  useEffect(() => {
    fetchAppointments();
  }, [fetchAppointments]);

  return {
    appointments,
    total,
    timezone,
    loading,

    activeTab,
    setActiveTab,

    page,
    setPage,

    fetchAppointments,
  };
}
