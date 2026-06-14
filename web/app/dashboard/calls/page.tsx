'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import { format } from 'date-fns';
import {
  Phone,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  PhoneIncoming,
  PhoneOutgoing,
} from 'lucide-react';

interface CallLog {
  id: string;
  vapiCallId: string;
  direction: string;
  durationSecs: number | null;
  outcome: string | null;
  createdAt: string;
  transcript: string | null;
  patient?: {
    name: string;
    phone: string;
  };
}

interface CallsResponse {
  calls: CallLog[];
  total: number;
}

function toIST(utcStr: string): string {
  const d = new Date(new Date(utcStr).getTime() + 5.5 * 60 * 60 * 1000);
  return format(d, 'MMM d, yyyy · h:mm a');
}

function formatDuration(secs: number | null): string {
  if (!secs) return '—';

  const m = Math.floor(secs / 60);
  const s = secs % 60;

  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function CallLogsPage() {
  const [calls, setCalls] = useState<CallLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const totalPages = Math.ceil(total / 20);

  useEffect(() => {
    let mounted = true;

    const loadCalls = async () => {
      try {
        const response = await api.get<CallsResponse>(
          '/dashboard/calls',
          {
            params: {
              page,
              limit: 20,
            },
          }
        );

        if (!mounted) return;

        setCalls(response.data.calls);
        setTotal(response.data.total);
      } catch (err) {
        console.error(err);
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    loadCalls();

    return () => {
      mounted = false;
    };
  }, [page]);

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">
          Call Logs
        </h1>
        <p className="text-sm text-gray-400 mt-1">
          {total} total calls recorded
        </p>
      </div>

      <div className="bg-gray-900 rounded-xl border border-gray-800">
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : calls.length === 0 ? (
          <div className="py-20 text-center">
            <Phone className="w-8 h-8 text-gray-700 mx-auto mb-3" />
            <p className="text-sm text-gray-500">
              No calls recorded yet
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-5 px-6 py-3 border-b border-gray-800 text-xs font-medium text-gray-500 uppercase tracking-wider">
              <span className="col-span-2">Patient</span>
              <span>Duration</span>
              <span>Outcome</span>
              <span>Date & Time</span>
            </div>

            <div className="divide-y divide-gray-800">
              {calls.map((call) => {
                const isExpanded = expanded === call.id;
                const patientName =
                  call.patient?.name ?? 'Unknown caller';

                const hasTranscript =
                  typeof call.transcript === 'string' &&
                  call.transcript.trim().length > 0;

                return (
                  <div key={call.id}>
                    <div
                      className="grid grid-cols-5 px-6 py-4 hover:bg-gray-800/50 transition-colors items-center cursor-pointer"
                      onClick={() =>
                        setExpanded(
                          isExpanded ? null : call.id
                        )
                      }
                    >
                      <div className="col-span-2 flex items-center gap-3">
                        <div
                          className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${
                            call.direction === 'inbound'
                              ? 'bg-green-600/20'
                              : 'bg-blue-600/20'
                          }`}
                        >
                          {call.direction === 'inbound' ? (
                            <PhoneIncoming className="w-4 h-4 text-green-400" />
                          ) : (
                            <PhoneOutgoing className="w-4 h-4 text-blue-400" />
                          )}
                        </div>

                        <div>
                          <p className="text-sm font-medium text-white">
                            {patientName}
                          </p>

                          <p className="text-xs text-gray-500 capitalize">
                            {call.direction} call
                          </p>
                        </div>
                      </div>

                      <span className="text-sm text-gray-300 font-mono">
                        {formatDuration(call.durationSecs)}
                      </span>

                      <div>
                        {call.outcome ? (
                          <span className="text-xs px-2 py-1 rounded-full bg-gray-800 text-gray-300 capitalize">
                            {call.outcome}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-600">
                            —
                          </span>
                        )}
                      </div>

                      <div className="flex items-center justify-between">
                        <span className="text-sm text-gray-400">
                          {toIST(call.createdAt)}
                        </span>

                        {hasTranscript &&
                          (isExpanded ? (
                            <ChevronUp className="w-4 h-4 text-gray-500" />
                          ) : (
                            <ChevronDown className="w-4 h-4 text-gray-500" />
                          ))}
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="px-6 pb-5 bg-gray-950/50 border-t border-gray-800">
                        {!hasTranscript ? (
                          <p className="text-xs text-gray-600 pt-4">
                            No transcript available for this call
                          </p>
                        ) : (
                          <>
                            <p className="text-xs font-medium text-gray-500 pt-4 mb-3 uppercase tracking-wider">
                              Transcript
                            </p>

                            <div className="max-h-96 overflow-y-auto rounded-lg border border-gray-800 bg-gray-900 p-4">
                              <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed text-gray-300 font-mono">
                                {call.transcript}
                              </pre>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {totalPages > 1 && (
              <div className="px-6 py-4 border-t border-gray-800 flex items-center justify-between">
                <span className="text-xs text-gray-500">
                  Page {page} of {totalPages} · {total} calls
                </span>

                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setLoading(true);
                      setPage((p) => Math.max(1, p - 1));
                    }}
                    disabled={page === 1}
                    className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-300 disabled:opacity-40 hover:bg-gray-800"
                  >
                    <ChevronLeft className="w-3 h-3" />
                    Previous
                  </button>

                  <button
                    onClick={() => {
                      setLoading(true);
                      setPage((p) =>
                        Math.min(totalPages, p + 1)
                      );
                    }}
                    disabled={page === totalPages}
                    className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-300 disabled:opacity-40 hover:bg-gray-800"
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