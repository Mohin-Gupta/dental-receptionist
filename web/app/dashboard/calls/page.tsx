'use client';

import { useState } from 'react';

import { Phone } from 'lucide-react';
import PageHeader from '@/components/ui/PageHeader';

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
    <div className="page-shell">
      <PageHeader
        eyebrow="Conversation intelligence"
        title="Call logs"
        icon={Phone}
        description={
          <>
            <span className="font-semibold text-ink-soft">{total}</span>{' '}
            {activeTab} calls recorded for this clinic
          </>
        }
      />

      <CallTabs
        activeTab={activeTab}
        onChange={(tab) => {
          setActiveTab(tab);
          setPage(1);
          setExpanded(null);
        }}
      />

      <section className="surface-card overflow-hidden" aria-label={`${activeTab} call logs`}>
        {loading ? (
          <div className="space-y-1 p-4 sm:p-5" role="status" aria-label="Loading call logs">
            {[0, 1, 2, 3].map((row) => (
              <div key={row} className="flex items-center gap-4 rounded-xl px-2 py-3">
                <span className="skeleton h-10 w-10 shrink-0 rounded-xl" />
                <span className="skeleton h-3.5 w-36" />
                <span className="skeleton ml-auto hidden h-3.5 w-24 sm:block" />
                <span className="skeleton hidden h-7 w-24 md:block" />
              </div>
            ))}
            <span className="sr-only">Loading call logs</span>
          </div>
        ) : calls.length === 0 ? (
          <div className="px-5 py-16 text-center sm:py-20">
            <span className="empty-illustration mx-auto">
              <Phone className="h-5 w-5" aria-hidden="true" />
            </span>
            <h2 className="mt-4 text-sm font-bold text-ink">No {activeTab} calls recorded yet</h2>
            <p className="mx-auto mt-1.5 max-w-sm text-xs leading-5 text-muted">
              Calls handled in this direction will appear here with their outcome and transcript.
            </p>
          </div>
        ) : (
          <>
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

            <div className="space-y-3 bg-surface-subtle p-3 sm:p-4 xl:hidden">
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
      </section>
    </div>
  );
}
