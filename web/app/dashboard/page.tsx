'use client';

import { useEffect, useMemo, useState } from 'react';
import api, { DashboardStats, Appointment } from '@/lib/api';
import {
  Calendar,
  Users,
  Phone,
  TrendingUp,
  Clock,
  CheckCircle,
  XCircle,
  AlertCircle,
} from 'lucide-react';
import { format } from 'date-fns';

function toIST(utcStr: string): string {
  const d = new Date(new Date(utcStr).getTime() + 5.5 * 60 * 60 * 1000);
  return format(d, 'h:mm a');
}

interface StatusConfigItem {
  color: string;
  bg: string;
  icon: React.ElementType;
  label: string;
}

const STATUS_CONFIG: Record<string, StatusConfigItem> = {
  confirmed: {
    color: 'text-emerald-400',
    bg: 'bg-emerald-400/10',
    icon: CheckCircle,
    label: 'Confirmed',
  },
  scheduled: {
    color: 'text-blue-400',
    bg: 'bg-blue-400/10',
    icon: Clock,
    label: 'Scheduled',
  },
  cancelled: {
    color: 'text-red-400',
    bg: 'bg-red-400/10',
    icon: XCircle,
    label: 'Cancelled',
  },
  completed: {
    color: 'text-gray-400',
    bg: 'bg-gray-400/10',
    icon: AlertCircle,
    label: 'Completed',
  },
};

interface StatCardProps {
  label: string;
  value: number;
  icon: React.ElementType;
  color: string;
  bg: string;
  border: string;
}

function StatCard({
  label,
  value,
  icon: Icon,
  color,
  bg,
  border,
}: StatCardProps) {
  return (
    <div className={`bg-gray-900 rounded-xl border ${border} p-5`}>
      <div className="flex items-center justify-between mb-4">
        <span className="text-sm text-gray-400">{label}</span>

        <div
          className={`w-9 h-9 rounded-lg ${bg} flex items-center justify-center`}
        >
          <Icon className={`w-4 h-4 ${color}`} />
        </div>
      </div>

      <p className={`text-3xl font-bold ${color}`}>{value}</p>
    </div>
  );
}

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get<DashboardStats>('/dashboard/stats')
      .then((r) => setStats(r.data))
      .catch(() => setError('Failed to load dashboard stats'))
      .finally(() => setLoading(false));
  }, []);

  const currentTime = useMemo(() => new Date(), []);

  const nowIST = useMemo(
    () =>
      new Date(
        currentTime.getTime() + 5.5 * 60 * 60 * 1000
      ),
    [currentTime]
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="flex flex-col items-center gap-3">
          <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-gray-400 text-sm">
            Loading dashboard...
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <AlertCircle className="w-8 h-8 text-red-400 mx-auto mb-2" />
          <p className="text-gray-400 text-sm">{error}</p>
        </div>
      </div>
    );
  }

  const statCards: StatCardProps[] = [
    {
      label: "Today's appointments",
      value: stats?.todayAppointments ?? 0,
      icon: Calendar,
      color: 'text-blue-400',
      bg: 'bg-blue-400/10',
      border: 'border-blue-400/20',
    },
    {
      label: 'Upcoming total',
      value: stats?.upcomingAppointments ?? 0,
      icon: TrendingUp,
      color: 'text-purple-400',
      bg: 'bg-purple-400/10',
      border: 'border-purple-400/20',
    },
    {
      label: 'Total patients',
      value: stats?.totalPatients ?? 0,
      icon: Users,
      color: 'text-emerald-400',
      bg: 'bg-emerald-400/10',
      border: 'border-emerald-400/20',
    },
    {
      label: 'Calls today',
      value: stats?.callsToday ?? 0,
      icon: Phone,
      color: 'text-orange-400',
      bg: 'bg-orange-400/10',
      border: 'border-orange-400/20',
    },
  ];

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">
          Overview
        </h1>

        <p className="text-gray-400 text-sm mt-1">
          {format(nowIST, 'EEEE, MMMM d yyyy')} ·{' '}
          {format(nowIST, 'h:mm a')} IST
        </p>
      </div>

      <div className="grid grid-cols-4 gap-4 mb-8">
        {statCards.map((card) => (
          <StatCard key={card.label} {...card} />
        ))}
      </div>

      <div className="bg-gray-900 rounded-xl border border-gray-800">
        <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">
            Today&apos;s Schedule
          </h2>

          <span className="text-xs text-gray-400">
            {stats?.todayAppointmentsList?.length ?? 0}{' '}
            appointments
          </span>
        </div>

        {!stats?.todayAppointmentsList?.length ? (
          <div className="px-6 py-16 text-center">
            <Calendar className="w-8 h-8 text-gray-700 mx-auto mb-3" />
            <p className="text-sm text-gray-500">
              No appointments scheduled for today
            </p>
          </div>
        ) : (
          <div className="divide-y divide-gray-800">
            {stats.todayAppointmentsList.map(
              (appt: Appointment) => {
                const config =
                  STATUS_CONFIG[appt.status] ??
                  STATUS_CONFIG.completed;

                const StatusIcon = config.icon;

                return (
                  <div
                    key={appt.id}
                    className="px-6 py-4 flex items-center justify-between hover:bg-gray-800/50 transition-colors"
                  >
                    <div className="flex items-center gap-4">
                      <div className="w-9 h-9 rounded-full bg-blue-600/20 flex items-center justify-center">
                        <span className="text-blue-400 text-sm font-semibold">
                          {appt.patient.name
                            .charAt(0)
                            .toUpperCase()}
                        </span>
                      </div>

                      <div>
                        <p className="text-sm font-medium text-white">
                          {appt.patient.name}
                        </p>

                        <p className="text-xs text-gray-400">
                          {appt.reason}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-4">
                      <span className="text-sm font-medium text-white">
                        {toIST(appt.startAt)}
                      </span>

                      <div
                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full ${config.bg}`}
                      >
                        <StatusIcon
                          className={`w-3 h-3 ${config.color}`}
                        />

                        <span
                          className={`text-xs font-medium ${config.color}`}
                        >
                          {config.label}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              }
            )}
          </div>
        )}
      </div>
    </div>
  );
}