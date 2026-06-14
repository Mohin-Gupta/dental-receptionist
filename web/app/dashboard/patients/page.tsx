'use client';

import { useEffect, useState } from 'react';
import api, { PatientWithStats } from '@/lib/api';
import { format } from 'date-fns';
import {
  Search,
  Users,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';

function toIST(utcStr: string): string {
  const d = new Date(
    new Date(utcStr).getTime() +
      5.5 * 60 * 60 * 1000
  );

  return format(d, 'MMM d, yyyy');
}

interface PatientsResponse {
  patients: PatientWithStats[];
  total: number;
}

export default function PatientsPage() {
  const [patients, setPatients] = useState<
    PatientWithStats[]
  >([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const totalPages = Math.ceil(total / 20);

  useEffect(() => {
    let mounted = true;

    const loadPatients = async () => {
      try {
        const params: Record<
          string,
          string | number
        > = {
          page,
          limit: 20,
        };

        if (search) {
          params.search = search;
        }

        const response =
          await api.get<PatientsResponse>(
            '/dashboard/patients',
            { params }
          );

        if (!mounted) return;

        setPatients(response.data.patients);
        setTotal(response.data.total);
      } catch (err) {
        console.error(err);
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    loadPatients();

    return () => {
      mounted = false;
    };
  }, [page, search]);

  return (
    <div className="p-4 md:p-6 lg:p-8">
      <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">
            Patients
          </h1>

          <p className="text-sm text-gray-400 mt-1">
            {total} registered patients
          </p>
        </div>

        <div className="relative w-full md:w-64">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />

          <input
            type="text"
            placeholder="Search name or phone..."
            value={search}
            onChange={(e) => {
              setLoading(true);
              setSearch(e.target.value);
              setPage(1);
            }}
            className="w-full pl-9 pr-4 py-2 text-sm bg-gray-800 border border-gray-700 text-gray-200 placeholder-gray-500 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : patients.length === 0 ? (
          <div className="py-20 text-center">
            <Users className="w-8 h-8 text-gray-700 mx-auto mb-3" />
            <p className="text-sm text-gray-500">
              No patients found
            </p>
          </div>
        ) : (
          <>
            {/* Desktop Table */}
            <div className="hidden md:block">
              <div className="grid grid-cols-5 px-6 py-3 border-b border-gray-800 text-xs font-medium text-gray-500 uppercase tracking-wider">
                <span className="col-span-2">
                  Patient
                </span>
                <span>Phone</span>
                <span>Total Visits</span>
                <span>Last Visit</span>
              </div>

              <div className="divide-y divide-gray-800">
                {patients.map((p) => (
                  <div
                    key={p.id}
                    className="grid grid-cols-5 px-6 py-4 hover:bg-gray-800/50 transition-colors items-center"
                  >
                    <div className="col-span-2 flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full bg-purple-600/20 flex items-center justify-center">
                        <span className="text-purple-400 text-sm font-semibold">
                          {p.name
                            .charAt(0)
                            .toUpperCase()}
                        </span>
                      </div>

                      <div>
                        <p className="text-sm font-medium text-white">
                          {p.name}
                        </p>

                        <p className="text-xs text-gray-500">
                          Since{' '}
                          {format(
                            new Date(
                              p.createdAt
                            ),
                            'MMM yyyy'
                          )}
                        </p>
                      </div>
                    </div>

                    <span className="text-sm text-gray-300 font-mono">
                      {p.phone}
                    </span>

                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-white">
                        {
                          p._count
                            .appointments
                        }
                      </span>

                      <span className="text-xs text-gray-500">
                        visits
                      </span>
                    </div>

                    <span className="text-sm text-gray-400">
                      {p.appointments[0]
                        ? toIST(
                            p.appointments[0]
                              .startAt
                          )
                        : '—'}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Mobile Cards */}
            <div className="md:hidden divide-y divide-gray-800">
              {patients.map((p) => (
                <div
                  key={p.id}
                  className="p-4"
                >
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-full bg-purple-600/20 flex items-center justify-center">
                      <span className="text-purple-400 font-semibold">
                        {p.name
                          .charAt(0)
                          .toUpperCase()}
                      </span>
                    </div>

                    <div>
                      <p className="text-white font-medium">
                        {p.name}
                      </p>

                      <p className="text-xs text-gray-500">
                        Since{' '}
                        {format(
                          new Date(
                            p.createdAt
                          ),
                          'MMM yyyy'
                        )}
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <p className="text-xs text-gray-500 mb-1">
                        Phone
                      </p>

                      <p className="text-gray-300">
                        {p.phone}
                      </p>
                    </div>

                    <div>
                      <p className="text-xs text-gray-500 mb-1">
                        Visits
                      </p>

                      <p className="text-gray-300">
                        {
                          p._count
                            .appointments
                        }
                      </p>
                    </div>

                    <div className="col-span-2">
                      <p className="text-xs text-gray-500 mb-1">
                        Last Visit
                      </p>

                      <p className="text-gray-300">
                        {p.appointments[0]
                          ? toIST(
                              p
                                .appointments[0]
                                .startAt
                            )
                          : '—'}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {totalPages > 1 && (
              <div className="px-4 md:px-6 py-4 border-t border-gray-800 flex flex-col md:flex-row gap-3 md:justify-between md:items-center">
                <span className="text-xs text-gray-500">
                  Page {page} of {totalPages}
                </span>

                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setLoading(true);
                      setPage((p) =>
                        Math.max(
                          1,
                          p - 1
                        )
                      );
                    }}
                    disabled={page === 1}
                    className="flex-1 md:flex-none flex items-center justify-center gap-1 text-xs px-3 py-2 rounded-lg border border-gray-700 text-gray-300 disabled:opacity-40 hover:bg-gray-800"
                  >
                    <ChevronLeft className="w-3 h-3" />
                    Previous
                  </button>

                  <button
                    onClick={() => {
                      setLoading(true);
                      setPage((p) =>
                        Math.min(
                          totalPages,
                          p + 1
                        )
                      );
                    }}
                    disabled={
                      page === totalPages
                    }
                    className="flex-1 md:flex-none flex items-center justify-center gap-1 text-xs px-3 py-2 rounded-lg border border-gray-700 text-gray-300 disabled:opacity-40 hover:bg-gray-800"
                  >
                    Next
                    <ChevronRight className="w-3 h-3" />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}