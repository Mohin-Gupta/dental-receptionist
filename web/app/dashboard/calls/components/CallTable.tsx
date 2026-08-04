import { Fragment } from 'react';

import {
  CallLog,
  formatDateTime,
} from '@/lib/api';

import {
  ChevronDown,
  ChevronUp,
  PhoneIncoming,
  PhoneOutgoing,
} from 'lucide-react';

import {
  formatDuration,
  getDisplayPhone,
} from '../utils/callHelpers';

import TranscriptPanel from './TranscriptPanel';

interface Props {
  calls: CallLog[];
  timezone: string;
  expanded: string | null;
  onToggle: (
    id: string
  ) => void;
}

export default function CallTable({
  calls,
  timezone,
  expanded,
  onToggle,
}: Props) {
  return (
    <div className="hidden max-w-full overflow-x-auto xl:block">
      <table className="w-full min-w-[820px] table-fixed border-collapse text-left">
        <colgroup>
          <col style={{ width: '30%' }} />
          <col style={{ width: '12%' }} />
          <col style={{ width: '17%' }} />
          <col style={{ width: '25%' }} />
          <col style={{ width: '16%' }} />
        </colgroup>
        <thead className="data-header">
          <tr>
            <th scope="col" className="px-6 py-3.5">Caller</th>
            <th scope="col" className="px-4 py-3.5">Duration</th>
            <th scope="col" className="px-4 py-3.5">Outcome</th>
            <th scope="col" className="px-4 py-3.5">Date &amp; time</th>
            <th scope="col" className="px-6 py-3.5 text-right">Transcript</th>
          </tr>
        </thead>

        <tbody>
        {calls.map((call) => {
          const isExpanded =
            expanded === call.id;

          const hasTranscript =
            typeof call.transcript ===
              'string' &&
            call.transcript.trim()
              .length > 0;

          const displayPhone =
            getDisplayPhone(call);
          const transcriptId = `call-transcript-${call.id}`;

          return (
            <Fragment key={call.id}>
              <tr
                className={`data-row ${hasTranscript ? 'cursor-pointer' : ''}`}
                onClick={hasTranscript ? () => onToggle(call.id) : undefined}
              >
                <th scope="row" className="px-6 py-4 font-normal">
                  <div className="flex items-center gap-3">
                    <span
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${
                      call.direction ===
                      'inbound'
                        ? 'border-[#cce7dc] bg-success-soft text-success'
                        : 'border-[#cce1e8] bg-info-soft text-info'
                    }`}
                  >
                    {call.direction ===
                    'inbound' ? (
                      <PhoneIncoming className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <PhoneOutgoing className="h-4 w-4" aria-hidden="true" />
                    )}
                    </span>

                    <div className="min-w-0">
                      <p className="max-w-[15rem] truncate text-[0.82rem] font-bold text-ink">
                        {call.patient?.name ?? displayPhone}
                      </p>

                      <p className="mt-1 max-w-[15rem] truncate font-mono text-[0.66rem] text-muted">
                        {call.patient?.name ? displayPhone : `${call.direction} call`}
                      </p>
                    </div>
                  </div>
                </th>

                <td className="px-4 py-4 text-[0.78rem] font-semibold text-ink-soft">
                  {formatDuration(
                    call.durationSecs
                  )}
                </td>

                <td className="px-4 py-4">
                  {call.outcome ? (
                    <span className="status-pill status-neutral max-w-full capitalize">
                      <span className="min-w-0 truncate">{call.outcome}</span>
                    </span>
                  ) : (
                    <span className="text-xs text-muted">
                      —
                    </span>
                  )}
                </td>

                <td className="px-4 py-4 text-[0.76rem] font-medium leading-5 text-muted">
                    {formatDateTime(
                      call.createdAt,
                      timezone
                    )}
                </td>

                <td className="px-6 py-4 text-right">
                  {hasTranscript ? (
                    <button
                      type="button"
                      className="btn-ghost btn-compact"
                      onClick={(event) => {
                        event.stopPropagation();
                        onToggle(call.id);
                      }}
                      aria-expanded={isExpanded}
                      aria-controls={transcriptId}
                    >
                      {isExpanded ? 'Hide' : 'View'}
                      {isExpanded ? (
                        <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                    </button>
                  ) : (
                    <span className="text-[0.68rem] text-muted">Not available</span>
                  )}
                </td>
              </tr>

              {isExpanded &&
                hasTranscript && (
                  <tr id={transcriptId}>
                    <td colSpan={5} className="border-b border-line bg-surface-subtle px-6 pb-5 pt-4">
                      <p className="mb-3 text-[0.62rem] font-bold uppercase tracking-[0.12em] text-brand">
                        Conversation transcript
                      </p>
                      <div className="max-h-96 overflow-y-auto">
                        <TranscriptPanel transcript={call.transcript!} />
                      </div>
                    </td>
                  </tr>
                )}
            </Fragment>
          );
        })}
        </tbody>
      </table>
    </div>
  );
}
