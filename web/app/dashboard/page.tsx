'use client';

import { useEffect, useState } from 'react';
import api, { Appointment, DashboardStats } from '@/lib/api';
import { Calendar, Users, Phone, Clock } from 'lucide-react';
import { format } from 'date-fns';

function StatCard({ label, value, icon: Icon, color }: {
  label: string; value: number; icon: any; color: string;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm text-gray-500">{label}</span>
        <div className={`w-8 h-8 rounded-lg ${color} flex items-center justify-center`}>
          <Icon className="w-4 h-4 text-white" />
        </div>
      </div>
      <p className="text-2xl font-semibold text-gray-900">{value}</p>
    </div>
  );
}

function statusColor(status: string) {
  switch (status) {
    case 'confirmed': return 'bg-green-100 text-green-700';
    case 'scheduled': return 'bg-blue-100 text-blue-700';
    case 'cancelled': return 'bg-red-100 text-red-700';
    default: return 'bg-gray-100 text-gray-600';
  }
}

function toIST(utcStr: string) {
  const d = new Date(new Date(utcStr).getTime() + 5.5 * 60 * 60 * 1000);
  return format(d, 'h:mm a');
}

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/dashboard/stats')
      .then(r => setStats(r.data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-gray-900">Overview</h1>
        <p className="text-sm text-gray-500 mt-1">{format(new Date(), 'EEEE, MMMM d yyyy')}</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-8">
        <StatCard label="Today's appointments" value={stats?.todayAppointments ?? 0} icon={Calendar} color="bg-blue-500" />
        <StatCard label="Upcoming total" value={stats?.upcomingAppointments ?? 0} icon={Clock} color="bg-purple-500" />
        <StatCard label="Total patients" value={stats?.totalPatients ?? 0} icon={Users} color="bg-green-500" />
        <StatCard label="Calls today" value={stats?.callsToday ?? 0} icon={Phone} color="bg-orange-500" />
      </div>

      {/* Today's appointments */}
      <div className="bg-white rounded-xl border border-gray-200">
        <div className="px-5 py-4 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900">Today's Schedule</h2>
        </div>

        {stats?.todayAppointmentsList.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <p className="text-sm text-gray-400">No appointments today</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {stats?.todayAppointmentsList.map((appt: Appointment) => (
              <div key={appt.id} className="px-5 py-4 flex items-center justify-between hover:bg-gray-50">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center">
                    <span className="text-blue-600 text-xs font-semibold">
                      {appt.patient.name.charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-900">{appt.patient.name}</p>
                    <p className="text-xs text-gray-500">{appt.reason}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-gray-600 font-medium">{toIST(appt.startAt)}</span>
                  <span className={`text-xs px-2 py-1 rounded-full font-medium ${statusColor(appt.status)}`}>
                    {appt.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}