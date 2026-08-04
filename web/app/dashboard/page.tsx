'use client';

import StatCard, { type StatCardProps } from './components/StatCard';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import axios from 'axios';
import api, { DashboardStats, Appointment, formatTime, nowInTimezone } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import PageHeader from '@/components/ui/PageHeader';
import SectionCard from '@/components/ui/SectionCard';
import EmptyState from './shared/components/EmptyState';
import LoadingState from './shared/components/LoadingState';
import {
  Activity,
  Calendar,
  CalendarClock,
  Users,
  Phone,
  Clock,
  CheckCircle2,
  XCircle,
  AlertCircle,
  ShieldAlert,
  CalendarDays,
} from 'lucide-react';

interface StatusConfigItem {
  className: string;
  icon: React.ElementType;
  label: string;
}

const STATUS_CONFIG: Record<string, StatusConfigItem> = {
  confirmed: { className: 'status-success', icon: CheckCircle2, label: 'Confirmed' },
  scheduled: { className: 'status-info', icon: Clock, label: 'Scheduled' },
  cancelled: { className: 'status-danger', icon: XCircle, label: 'Cancelled' },
  completed: { className: 'status-neutral', icon: CheckCircle2, label: 'Completed' },
};

export default function DashboardPage() {
  const {
    activeOrganizationId,
    activeClinicId,
  } = useAuth();

  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [mfaRequired, setMfaRequired] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError('');
    setMfaRequired(false);

    api.get<DashboardStats>('/dashboard/stats')
      .then(r => setStats(r.data))
      .catch((err) => {
        if (axios.isAxiosError(err) && (err.response?.data?.mfaRequired || err.response?.data?.mfaSetupRequired)) {
          setMfaRequired(true);
          setError(
            err.response?.data?.mfaSetupRequired
              ? "Stats can't load until multi-factor authentication is set up for your account."
              : "Stats can't load until this session completes multi-factor authentication."
          );
          return;
        }
        const serverMessage = axios.isAxiosError(err) && typeof err.response?.data?.error === 'string'
          ? err.response.data.error
          : null;
        setError(serverMessage ?? 'Failed to load dashboard stats. Please try again.');
      })
      .finally(() => setLoading(false));
  }, [activeOrganizationId, activeClinicId]);

  // Use timezone from API response — falls back to IST for existing clinics
  const timezone = stats?.timezone ?? 'Asia/Kolkata';

  // Current time displayed in the clinic's timezone, recalculated when timezone loads
  const [currentTime, setCurrentTime] = useState(nowInTimezone(timezone));

  useEffect(() => {
    setCurrentTime(nowInTimezone(timezone));

    const interval = setInterval(() => {
      setCurrentTime(nowInTimezone(timezone));
    }, 1000);

    return () => clearInterval(interval);
  }, [timezone]);

  if (loading) {
    return (
      <div className="page-shell">
        <div className="mb-7 space-y-3" aria-hidden="true">
          <div className="skeleton h-3 w-28" />
          <div className="skeleton h-10 w-56" />
          <div className="skeleton h-4 w-72 max-w-full" />
        </div>
        <div className="surface-card">
          <LoadingState height="min-h-[420px]" label="Preparing today’s overview" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page-shell">
        <PageHeader
          eyebrow="Daily operations"
          title="Overview"
          description="A current view of your clinic’s appointments, patients, and calls."
          icon={Activity}
        />
        <div className="surface-card flex min-h-[420px] items-center justify-center p-6" role="alert">
          <div className="max-w-md text-center">
            <span className={`mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border ${
              mfaRequired
                ? 'border-[#efddb7] bg-warning-soft text-warning'
                : 'border-[#efd0cc] bg-danger-soft text-danger'
            }`}>
              {mfaRequired ? (
                <ShieldAlert className="h-6 w-6" aria-hidden="true" />
              ) : (
                <AlertCircle className="h-6 w-6" aria-hidden="true" />
              )}
            </span>
            <h2 className="mt-5 text-base font-semibold text-ink">
              {mfaRequired ? 'Security check required' : 'Overview unavailable'}
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted">{error}</p>
            {mfaRequired && (
              <Link href="/mfa" className="btn-primary mt-5">
                <ShieldAlert className="h-4 w-4" aria-hidden="true" />
                Go to MFA setup
              </Link>
            )}
          </div>
        </div>
      </div>
    );
  }

  const statCards: StatCardProps[] = [
    {
      label: "Today's appointments",
      value: stats?.todayAppointments ?? 0,
      icon: Calendar,
      tone: 'brand',
      context: 'Scheduled for today',
    },
    {
      label: 'Upcoming',
      value: stats?.upcomingAppointments ?? 0,
      icon: CalendarClock,
      tone: 'info',
      context: 'Future bookings',
    },
    {
      label: 'Total patients',
      value: stats?.totalPatients ?? 0,
      icon: Users,
      tone: 'success',
      context: 'Patient records',
    },
    {
      label: 'Calls today',
      value: stats?.callsToday ?? 0,
      icon: Phone,
      tone: 'warm',
      context: 'Handled since midnight',
    },
  ];

  return (
    <div className="page-shell">
      <PageHeader
        eyebrow="Daily operations"
        title="Overview"
        icon={Activity}
        description={(
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{currentTime.formatted}</span>
            <span className="h-1 w-1 rounded-full bg-[#a5b2ad]" aria-hidden="true" />
            <span className="font-semibold text-ink-soft">{currentTime.time}</span>
            <span className="text-muted">in your clinic timezone</span>
          </span>
        )}
      />

      <section aria-labelledby="clinic-pulse-heading">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <p className="section-kicker">Clinic pulse</p>
            <h2 id="clinic-pulse-heading" className="mt-1 text-sm font-semibold text-ink">
              Today’s operating picture
            </h2>
          </div>
          <span className="status-pill status-success">
            <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
            Current
          </span>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {statCards.map(card => <StatCard key={card.label} {...card} />)}
        </div>
      </section>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(260px,0.38fr)]">
        <SectionCard
          title="Today’s schedule"
          description="Appointments arranged in your clinic’s local time."
          eyebrow="Patient flow"
          icon={CalendarDays}
          className="min-w-0"
          contentClassName="p-0 sm:p-0"
          action={(
            <span className="status-pill status-neutral">
              {stats?.todayAppointmentsList?.length ?? 0} appointment{stats?.todayAppointmentsList?.length === 1 ? '' : 's'}
            </span>
          )}
        >
          {!stats?.todayAppointmentsList?.length ? (
            <EmptyState
              icon={Calendar}
              title="A clear schedule"
              message="No appointments are scheduled for today. New bookings will appear here automatically."
            />
          ) : (
            <div className="divide-y divide-[#e7ecea]">
              {stats.todayAppointmentsList.map((appt: Appointment) => {
                const config = STATUS_CONFIG[appt.status] ?? STATUS_CONFIG.completed;
                const StatusIcon = config.icon;

                return (
                  <article
                    key={appt.id}
                    className="group grid gap-3 px-4 py-4 transition-colors hover:bg-[#fafcfb] sm:grid-cols-[5.6rem_minmax(0,1fr)_auto] sm:items-center sm:px-5"
                  >
                    <div className="flex items-center gap-2 sm:block">
                      <p className="text-sm font-bold tracking-[-0.02em] text-ink">
                        {formatTime(appt.startAt, timezone)}
                      </p>
                      <p className="text-[0.62rem] font-semibold uppercase tracking-[0.1em] text-muted sm:mt-1">
                        Local time
                      </p>
                    </div>

                    <div className="flex min-w-0 items-center gap-3 border-l-0 border-[#d8e2de] sm:border-l sm:pl-5">
                      <div className="avatar h-10 w-10 text-sm">
                        {appt.patient.name.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-ink">{appt.patient.name}</p>
                        <p className="mt-0.5 truncate text-xs text-muted">{appt.reason}</p>
                      </div>
                    </div>

                    <div className={`status-pill ${config.className}`}>
                      <StatusIcon className="h-3 w-3" aria-hidden="true" />
                      {config.label}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </SectionCard>

        <aside className="surface-card overflow-hidden" aria-labelledby="history-heading">
          <div className="border-b border-line px-5 py-[1.2rem]">
            <p className="section-kicker">Appointment history</p>
            <h2 id="history-heading" className="mt-1 text-[0.95rem] font-bold tracking-[-0.018em] text-ink">
              Current totals
            </h2>
          </div>

          <div className="grid grid-cols-2 divide-x divide-line xl:grid-cols-1 xl:divide-x-0 xl:divide-y">
            <div className="p-5">
              <div className="flex items-center justify-between gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#d5e5df] bg-surface-subtle text-muted">
                  <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                </span>
                <span className="text-[0.62rem] font-bold uppercase tracking-[0.11em] text-muted">Past</span>
              </div>
              <p className="mt-5 text-3xl font-semibold tracking-[-0.055em] text-ink">
                {(stats?.pastAppointments ?? 0).toLocaleString()}
              </p>
              <p className="mt-1 text-xs leading-5 text-muted">Appointments already elapsed</p>
            </div>

            <div className="p-5">
              <div className="flex items-center justify-between gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#efd4d0] bg-danger-soft text-danger">
                  <XCircle className="h-4 w-4" aria-hidden="true" />
                </span>
                <span className="text-[0.62rem] font-bold uppercase tracking-[0.11em] text-danger">Cancelled</span>
              </div>
              <p className="mt-5 text-3xl font-semibold tracking-[-0.055em] text-ink">
                {(stats?.cancelledAppointments ?? 0).toLocaleString()}
              </p>
              <p className="mt-1 text-xs leading-5 text-muted">Bookings marked as cancelled</p>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
