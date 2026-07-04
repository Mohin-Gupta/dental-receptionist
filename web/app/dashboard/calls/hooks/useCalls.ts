import { useEffect, useState } from 'react';

import api, {
  CallsResponse,
} from '@/lib/api';
import { useAuth } from '@/lib/auth';

import type { DirectionTab } from '../utils/callHelpers';

export default function useCalls() {
  const {
    activeOrganizationId,
    activeClinicId,
  } = useAuth();

  const [calls, setCalls] =
    useState<CallsResponse['calls']>(
      []
    );

  const [total, setTotal] =
    useState(0);

  const [timezone, setTimezone] =
    useState('Asia/Kolkata');

  const [page, setPage] =
    useState(1);

  const [activeTab, setActiveTab] =
    useState<DirectionTab>(
      'inbound'
    );

  const [loading, setLoading] =
    useState(true);

  useEffect(() => {
    let mounted = true;

    setLoading(true);

    const loadCalls =
      async () => {
        try {
          const response =
            await api.get<CallsResponse>(
              '/dashboard/calls',
              {
                params: {
                  page,
                  limit: 20,
                  direction:
                    activeTab,
                },
              }
            );

          if (!mounted) return;

          setCalls(
            response.data.calls
          );

          setTotal(
            response.data.total
          );

          setTimezone(
            response.data.timezone
          );
        } catch (err) {
          console.error(err);
        } finally {
          if (mounted)
            setLoading(false);
        }
      };

    loadCalls();

    return () => {
      mounted = false;
    };
  }, [
    activeClinicId,
    activeOrganizationId,
    page,
    activeTab,
  ]);

  return {
    calls,
    total,
    timezone,
    page,
    setPage,
    activeTab,
    setActiveTab,
    loading,
  };
}
