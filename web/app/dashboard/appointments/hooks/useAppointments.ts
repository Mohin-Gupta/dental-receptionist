import { useCallback, useEffect, useState } from 'react';
import api, {
  Appointment,
  AppointmentsResponse,
} from '@/lib/api';

export type TabType =
  | 'upcoming'
  | 'past'
  | 'cancelled';

export default function useAppointments() {
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
    }, [activeTab, page]);

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