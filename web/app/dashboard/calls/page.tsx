'use client';

import { useState } from 'react';

import { Phone } from 'lucide-react';

import useCalls from './hooks/useCalls';

import CallTabs from './components/CallTabs';
import CallTable from './components/CallTable';
import CallCard from './components/CallCard';

import Pagination from '../shared/components/Pagination';

export default function CallLogsPage() {
  const {
    calls,
    total,
    timezone,
    page,
    setPage,
    activeTab,
    setActiveTab,
    loading,
  } = useCalls();

  const [expanded, setExpanded] =
    useState<string | null>(null);

  const totalPages = Math.ceil(total / 20);

  return (
    <div className="p-4 md:p-6 lg:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">
          Call Logs
        </h1>

        <p className="text-sm text-gray-400 mt-1">
          {total} {activeTab} calls
          recorded
        </p>
      </div>

      <CallTabs
        activeTab={activeTab}
        onChange={(tab) => {
          setActiveTab(tab);
          setPage(1);
          setExpanded(null);
        }}
      />

      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : calls.length === 0 ? (
          <div className="py-20 text-center">
            <Phone className="w-8 h-8 text-gray-700 mx-auto mb-3" />

            <p className="text-sm text-gray-500">
              No {activeTab} calls
              recorded yet
            </p>
          </div>
        ) : (
          <>
            {/* Desktop */}

            <CallTable
              calls={calls}
              timezone={timezone}
              expanded={expanded}
              onToggle={(id) =>
                setExpanded(
                  expanded === id
                    ? null
                    : id
                )
              }
            />

            {/* Mobile */}

            <div className="md:hidden divide-y divide-gray-800">
              {calls.map((call) => (
                <CallCard
                  key={call.id}
                  call={call}
                  timezone={timezone}
                  expanded={
                    expanded === call.id
                  }
                  onToggle={() =>
                    setExpanded(
                      expanded ===
                        call.id
                        ? null
                        : call.id
                    )
                  }
                />
              ))}
            </div>

            <Pagination
              page={page}
              totalPages={totalPages}
              total={total}
              onPrevious={() =>
                setPage((p) =>
                  Math.max(1, p - 1)
                )
              }
              onNext={() =>
                setPage((p) =>
                  Math.min(
                    totalPages,
                    p + 1
                  )
                )
              }
            />
          </>
        )}
      </div>
    </div>
  );
}