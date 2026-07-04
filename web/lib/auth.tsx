'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { usePathname, useRouter } from 'next/navigation';
import api, {
  AuthMeResponse,
  AuthClinic,
  AuthOrganization,
  AuthRole,
  AuthUser,
  refreshCsrfToken,
  setAuthScope,
  setCsrfToken,
} from './api';

interface AuthContextValue {
  user: AuthUser | null;
  role: AuthRole | null;
  activeOrganizationId: string | null;
  activeClinicId: string | null;
  organizations: AuthOrganization[];
  clinics: AuthClinic[];
  loading: boolean;
  refresh: () => Promise<void>;
  setScope: (organizationId: string, clinicId: string) => Promise<void>;
  logout: () => Promise<void>;
  canWriteAppointments: boolean;
  canManageSettings: boolean;
  canManageUsers: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function can(role: AuthRole | null, allowed: AuthRole[]): boolean {
  return !!role && allowed.includes(role);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get<AuthMeResponse>('/auth/me');
      setMe(response.data);
      setAuthScope(response.data.activeOrganization.id, response.data.activeClinic.id);
      await refreshCsrfToken().catch(() => null);
    } catch {
      setMe(null);
      setAuthScope(null, null);
      setCsrfToken(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!loading && !me && pathname.startsWith('/dashboard')) {
      router.replace('/sign-in');
    }
  }, [loading, me, pathname, router]);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      setMe(null);
      setAuthScope(null, null);
      setCsrfToken(null);
      router.replace('/sign-in');
    }
  }, [router]);

  const setScope = useCallback(
    async (organizationId: string, clinicId: string) => {
      setAuthScope(organizationId, clinicId);
      await refresh();
    },
    [refresh]
  );

  const value = useMemo<AuthContextValue>(() => {
    const role = me?.activeClinic.role ?? null;
    return {
      user: me?.user ?? null,
      role,
      activeOrganizationId: me?.activeOrganization.id ?? null,
      activeClinicId: me?.activeClinic.id ?? null,
      organizations: me?.organizations ?? [],
      clinics: me?.clinics ?? [],
      loading,
      refresh,
      setScope,
      logout,
      canWriteAppointments: can(role, ['owner', 'admin', 'staff']),
      canManageSettings: can(role, ['owner', 'admin']),
      canManageUsers: can(role, ['owner']),
    };
  }, [loading, logout, me, refresh, setScope]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
