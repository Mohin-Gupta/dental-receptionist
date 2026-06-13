'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import { Search } from 'lucide-react';
import { format } from 'date-fns';

export default function PatientsPage() {
  const [patients, setPatients] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const params: any = { page, limit: 20 };
    if (search) params.search = search;

    api.get('/dashboard/patients', { params })
      .then(r => { setPatients(r.data.patients); setTotal(r.data.total); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [page, search]);

  const totalPages = Math.ceil(total / 20);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Patients</h1>
          <p className="text-sm text-gray-500 mt-1">{total} total</p>
        </div>

        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Search by name or phone..."
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            className="pl-9 pr-4 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 w-64"
          />
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200">
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : patients.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-sm text-gray-400">No patients found</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-4 px-5 py-3 border-b border-gray-100 text-xs font-medium text-gray-500 uppercase tracking-wide">
              <span>Name</span>
              <span>Phone</span>
              <span>Total Visits</span>
              <span>Last Visit</span>
            </div>

            <div className="divide-y divide-gray-50">
              {patients.map((p: any) => (
                <div key={p.id} className="grid grid-cols-4 px-5 py-4 hover:bg-gray-50 items-center">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-purple-50 flex items-center justify-center">
                      <span className="text-purple-600 text-xs font-semibold">
                        {p.name.charAt(0).toUpperCase()}
                      </span>
                    </div>
                    <span className="text-sm font-medium text-gray-900">{p.name}</span>
                  </div>
                  <span className="text-sm text-gray-600">{p.phone}</span>
                  <span className="text-sm text-gray-600">{p._count.appointments}</span>
                  <span className="text-sm text-gray-600">
                    {p.appointments[0]
                      ? format(new Date(new Date(p.appointments[0].startAt).getTime() + 5.5 * 60 * 60 * 1000), 'MMM d, yyyy')
                      : '—'
                    }
                  </span>
                </div>
              ))}
            </div>

            {totalPages > 1 && (
              <div className="px-5 py-4 border-t border-gray-100 flex items-center justify-between">
                <span className="text-xs text-gray-500">Page {page} of {totalPages}</span>
                <div className="flex gap-2">
                  <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                    className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 disabled:opacity-40 hover:bg-gray-50">
                    Previous
                  </button>
                  <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                    className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 disabled:opacity-40 hover:bg-gray-50">
                    Next
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