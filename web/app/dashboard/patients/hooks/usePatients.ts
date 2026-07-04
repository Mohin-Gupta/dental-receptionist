import {
  useEffect,
  useState,
} from 'react';

import api, {
  PatientWithStats,
} from '@/lib/api';
import { useAuth } from '@/lib/auth';

interface PatientsResponse {
  patients: PatientWithStats[];
  total: number;
}

export default function usePatients() {
  const {
    activeOrganizationId,
    activeClinicId,
  } = useAuth();

  const [patients, setPatients] =
    useState<
      PatientWithStats[]
    >([]);

  const [total, setTotal] =
    useState(0);

  const [search, setSearch] =
    useState('');

  const [page, setPage] =
    useState(1);

  const [loading, setLoading] =
    useState(true);

  useEffect(() => {
    let mounted = true;

    const loadPatients =
      async () => {
        try {
          const params: Record<
            string,
            string | number
          > = {
            page,
            limit: 20,
          };

          if (
            search.trim()
          ) {
            params.search =
              search;
          }

          const response =
            await api.get<PatientsResponse>(
              '/dashboard/patients',
              {
                params,
              }
            );

          if (!mounted)
            return;

          setPatients(
            response.data
              .patients
          );

          setTotal(
            response.data
              .total
          );
        } catch (err) {
          console.error(
            err
          );
        } finally {
          if (mounted) {
            setLoading(
              false
            );
          }
        }
      };

    loadPatients();

    return () => {
      mounted = false;
    };
  }, [
    activeClinicId,
    activeOrganizationId,
    page,
    search,
  ]);

  return {
    patients,
    total,

    search,
    setSearch,

    page,
    setPage,

    loading,
    setLoading,
  };
}
