'use client';

import { useEffect, useState } from 'react';
import api, { CallsResponse, formatDateTime } from '@/lib/api';
import {
  Phone,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  PhoneIncoming,
  PhoneOutgoing,
} from 'lucide-react';

function formatDuration(secs: number | null): string {
  if (!secs) return '—';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// Always shows the number saved directly on the call log — only falls back
// to a generic label if the webhook genuinely could not extract one.
function getDisplayPhone(call: CallsResponse['calls'][number]): string {
  return call.phoneNumber ?? call.patient?.phone ?? 'No number recorded';
}

type DirectionTab = 'inbound' | 'outbound';

export default function CallLogsPage() {
  const [calls, setCalls] = useState<CallsResponse['calls']>([]);
  const [total, setTotal] = useState(0);
  const [timezone, setTimezone] = useState('Asia/Kolkata');
  const [page, setPage] = useState(1);
  const [activeTab, setActiveTab] = useState<DirectionTab>('inbound');
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const totalPages = Math.ceil(total / 20);

  useEffect(() => {
    let mounted = true;
    setLoading(true);

    const loadCalls = async () => {
      try {
        const response = await api.get<CallsResponse>('/dashboard/calls', {
          params: { page, limit: 20, direction: activeTab },
        });

        if (!mounted) return;

        setCalls(response.data.calls);
        setTotal(response.data.total);
        setTimezone(response.data.timezone);
      } catch (err) {
        console.error(err);
      } finally {
        if (mounted) setLoading(false);
      }
    };

    loadCalls();

    return () => { mounted = false; };
  }, [page, activeTab]);

  const tabs: { key: DirectionTab; label: string; icon: React.ElementType; description: string }[] = [
    { key: 'inbound', label: 'Inbound', icon: PhoneIncoming, description: 'Calls Maya answered from patients' },
    { key: 'outbound', label: 'Outbound', icon: PhoneOutgoing, description: 'Reminder calls Maya made' },
  ];

  return (
    <div className="p-4 md:p-6 lg:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Call Logs</h1>
        <p className="text-sm text-gray-400 mt-1">{total} {activeTab} calls recorded</p>
      </div>

      {/* Inbound / Outbound tabs */}
      <div className="flex gap-1 mb-5 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit">
        {tabs.map(tab => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              onClick={() => { setActiveTab(tab.key); setPage(1); }}
              title={tab.description}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                activeTab === tab.key
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-400 hover:text-white hover:bg-gray-800'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : calls.length === 0 ? (
          <div className="py-20 text-center">
            <Phone className="w-8 h-8 text-gray-700 mx-auto mb-3" />
            <p className="text-sm text-gray-500">No {activeTab} calls recorded yet</p>
          </div>
        ) : (
          <>
            {/* Desktop Table */}
            <div className="hidden md:block">
              <div className="grid grid-cols-5 px-6 py-3 border-b border-gray-800 text-xs font-medium text-gray-500 uppercase tracking-wider">
                <span className="col-span-2">Phone Number</span>
                <span>Duration</span>
                <span>Outcome</span>
                <span>Date & Time</span>
              </div>

              <div className="divide-y divide-gray-800">
                {calls.map((call) => {
                  const isExpanded = expanded === call.id;
                  const hasTranscript = typeof call.transcript === 'string' && call.transcript.trim().length > 0;
                  const displayPhone = getDisplayPhone(call);

                  return (
                    <div key={call.id}>
                      <div
                        className="grid grid-cols-5 px-6 py-4 hover:bg-gray-800/50 transition-colors items-center cursor-pointer"
                        onClick={() => setExpanded(isExpanded ? null : call.id)}
                      >
                        <div className="col-span-2 flex items-center gap-3">
                          <div className={`w-9 h-9 rounded-full flex items-center justify-center ${
                            call.direction === 'inbound' ? 'bg-green-600/20' : 'bg-blue-600/20'
                          }`}>
                            {call.direction === 'inbound' ? (
                              <PhoneIncoming className="w-4 h-4 text-green-400" />
                            ) : (
                              <PhoneOutgoing className="w-4 h-4 text-blue-400" />
                            )}
                          </div>
                          <div>
                            <p className="text-sm font-medium text-white font-mono">
                              {displayPhone}
                            </p>
                            <p className="text-xs text-gray-500 capitalize">{call.direction} call</p>
                          </div>
                        </div>

                        <span className="text-sm text-gray-300">{formatDuration(call.durationSecs)}</span>

                        <div>
                          {call.outcome ? (
                            <span className="text-xs px-2 py-1 rounded-full bg-gray-800 text-gray-300 capitalize">
                              {call.outcome}
                            </span>
                          ) : (
                            <span className="text-xs text-gray-600">—</span>
                          )}
                        </div>

                        <div className="flex items-center justify-between">
                          <span className="text-sm text-gray-400">{formatDateTime(call.createdAt, timezone)}</span>
                          {hasTranscript && (isExpanded ? (
                            <ChevronUp className="w-4 h-4 text-gray-500" />
                          ) : (
                            <ChevronDown className="w-4 h-4 text-gray-500" />
                          ))}
                        </div>
                      </div>

                      {isExpanded && hasTranscript && (
                        <div className="px-6 pb-5 bg-gray-950/50 border-t border-gray-800">
                          <p className="text-xs font-medium text-gray-500 pt-4 mb-3 uppercase tracking-wider">
                            Transcript
                          </p>
                          <div className="max-h-96 overflow-y-auto rounded-lg border border-gray-800 bg-gray-900 p-4">
                            <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed text-gray-300 font-mono">
                              {call.transcript}
                            </pre>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Mobile Cards */}
            <div className="md:hidden divide-y divide-gray-800">
              {calls.map((call) => {
                const isExpanded = expanded === call.id;
                const hasTranscript = typeof call.transcript === 'string' && call.transcript.trim().length > 0;
                const displayPhone = getDisplayPhone(call);

                return (
                  <div key={call.id}>
                    <div onClick={() => setExpanded(isExpanded ? null : call.id)} className="p-4 cursor-pointer">
                      <div className="flex items-start justify-between">
                        <div className="flex gap-3">
                          <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                            call.direction === 'inbound' ? 'bg-green-600/20' : 'bg-blue-600/20'
                          }`}>
                            {call.direction === 'inbound' ? (
                              <PhoneIncoming className="w-4 h-4 text-green-400" />
                            ) : (
                              <PhoneOutgoing className="w-4 h-4 text-blue-400" />
                            )}
                          </div>
                          <div>
                            <p className="text-white font-medium font-mono">{displayPhone}</p>
                            <p className="text-xs text-gray-500 capitalize">{call.direction} call</p>
                          </div>
                        </div>

                        {hasTranscript && (isExpanded ? (
                          <ChevronUp className="w-4 h-4 text-gray-500" />
                        ) : (
                          <ChevronDown className="w-4 h-4 text-gray-500" />
                        ))}
                      </div>

                      <div className="grid grid-cols-2 gap-4 mt-4 text-sm">
                        <div>
                          <p className="text-gray-500 text-xs mb-1">Duration</p>
                          <p className="text-gray-300">{formatDuration(call.durationSecs)}</p>
                        </div>
                        <div>
                          <p className="text-gray-500 text-xs mb-1">Outcome</p>
                          <p className="text-gray-300 capitalize">{call.outcome ?? '—'}</p>
                        </div>
                      </div>

                      <div className="mt-4">
                        <p className="text-gray-500 text-xs mb-1">Date & Time</p>
                        <p className="text-gray-300 text-sm">{formatDateTime(call.createdAt, timezone)}</p>
                      </div>
                    </div>

                    {isExpanded && hasTranscript && (
                      <div className="px-4 pb-4">
                        <div className="rounded-lg border border-gray-800 bg-gray-950 p-3">
                          <pre className="whitespace-pre-wrap break-words text-xs text-gray-300">
                            {call.transcript}
                          </pre>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {totalPages > 1 && (
              <div className="px-4 md:px-6 py-4 border-t border-gray-800 flex flex-col md:flex-row gap-3 md:justify-between md:items-center">
                <span className="text-xs text-gray-500">
                  Page {page} of {totalPages} · {total} calls
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => { setLoading(true); setPage(p => Math.max(1, p - 1)); }}
                    disabled={page === 1}
                    className="flex-1 md:flex-none flex items-center justify-center gap-1 text-xs px-3 py-2 rounded-lg border border-gray-700 text-gray-300 disabled:opacity-40 hover:bg-gray-800"
                  >
                    <ChevronLeft className="w-3 h-3" />
                    Previous
                  </button>
                  <button
                    onClick={() => { setLoading(true); setPage(p => Math.min(totalPages, p + 1)); }}
                    disabled={page === totalPages}
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