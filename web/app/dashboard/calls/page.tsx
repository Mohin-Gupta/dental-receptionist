'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import { format } from 'date-fns';
import { ChevronDown, ChevronRight, Phone } from 'lucide-react';

export default function CallLogsPage() {
  const [calls, setCalls] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    api.get('/dashboard/calls', { params: { page, limit: 20 } })
      .then(r => { setCalls(r.data.calls); setTotal(r.data.total); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [page]);

  const totalPages = Math.ceil(total / 20);

  const formatDuration = (secs: number) => {
    if (!secs) return '—';
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-gray-900">Call Logs</h1>
        <p className="text-sm text-gray-500 mt-1">{total} total calls</p>
      </div>

      <div className="bg-white rounded-xl border border-gray-200">
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : calls.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-sm text-gray-400">No calls yet</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-5 px-5 py-3 border-b border-gray-100 text-xs font-medium text-gray-500 uppercase tracking-wide">
              <span>Patient</span>
              <span>Direction</span>
              <span>Duration</span>
              <span>Outcome</span>
              <span>Date</span>
            </div>

            <div className="divide-y divide-gray-50">
              {calls.map((call: any) => (
                <div key={call.id}>
                  <div
                    className="grid grid-cols-5 px-5 py-4 hover:bg-gray-50 items-center cursor-pointer"
                    onClick={() => setExpanded(expanded === call.id ? null : call.id)}
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-orange-50 flex items-center justify-center">
                        <Phone className="w-3.5 h-3.5 text-orange-500" />
                      </div>
                      <span className="text-sm font-medium text-gray-900">
                        {call.patient?.name ?? 'Unknown'}
                      </span>
                    </div>
                    <span className="text-sm text-gray-600 capitalize">{call.direction}</span>
                    <span className="text-sm text-gray-600">{formatDuration(call.durationSecs)}</span>
                    <span className="text-sm text-gray-600">{call.outcome ?? '—'}</span>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-gray-600">
                        {format(new Date(call.createdAt), 'MMM d, h:mm a')}
                      </span>
                      {call.transcript?.length > 0 && (
                        expanded === call.id
                          ? <ChevronDown className="w-4 h-4 text-gray-400" />
                          : <ChevronRight className="w-4 h-4 text-gray-400" />
                      )}
                    </div>
                  </div>

                  {/* Transcript */}
                  {expanded === call.id && call.transcript?.length > 0 && (
                    <div className="px-5 pb-4 bg-gray-50 border-t border-gray-100">
                      <p className="text-xs font-medium text-gray-500 mt-3 mb-2">Transcript</p>
                      <div className="space-y-2 max-h-64 overflow-y-auto">
                        {call.transcript.map((line: any, i: number) => (
                          <div key={i} className={`flex gap-2 text-xs ${line.role === 'assistant' ? 'text-blue-700' : 'text-gray-700'}`}>
                            <span className="font-medium flex-shrink-0">
                              {line.role === 'assistant' ? 'Maya' : 'Patient'}:
                            </span>
                            <span>{line.message ?? line.content ?? ''}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
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