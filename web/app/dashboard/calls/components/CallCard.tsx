import { formatDateTime, CallLog } from '@/lib/api';

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
  call: CallLog;
  timezone: string;
  expanded: boolean;
  onToggle: () => void;
}

export default function CallCard({
  call,
  timezone,
  expanded,
  onToggle,
}: Props) {
  const hasTranscript =
    typeof call.transcript === 'string' &&
    call.transcript.trim().length > 0;

  const displayPhone =
    getDisplayPhone(call);
  const transcriptId = `call-transcript-${call.id}`;

  const summary = (
    <>
        <div className="flex items-start justify-between">
          <div className="flex min-w-0 flex-1 gap-3">
            <div
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${
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
            </div>

            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-ink">
                {call.patient?.name ?? displayPhone}
              </p>
              <p className="mt-1 truncate font-mono text-[0.68rem] text-muted">
                {call.patient?.name ? displayPhone : `${call.direction} call`}
              </p>
            </div>
          </div>

          {hasTranscript &&
            (expanded ? (
              <ChevronUp className="h-4 w-4 text-brand" aria-hidden="true" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted" aria-hidden="true" />
            ))}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2.5">
          <div className="rounded-xl bg-surface-subtle p-3">
            <p className="text-[0.62rem] font-bold uppercase tracking-[0.09em] text-muted">Duration</p>
            <p className="mt-1.5 text-xs font-bold text-ink-soft">
              {formatDuration(
                call.durationSecs
              )}
            </p>
          </div>

          <div className="rounded-xl bg-surface-subtle p-3">
            <p className="text-[0.62rem] font-bold uppercase tracking-[0.09em] text-muted">Outcome</p>
            <p className="mt-1.5 text-xs font-bold capitalize text-ink-soft">
              {call.outcome ?? '—'}
            </p>
          </div>
        </div>

        <div className="mt-2.5 rounded-xl border border-line bg-white p-3">
          <p className="text-[0.62rem] font-bold uppercase tracking-[0.09em] text-muted">Date &amp; time</p>
          <p className="mt-1.5 text-xs font-semibold text-ink-soft">
            {formatDateTime(
              call.createdAt,
              timezone
            )}
          </p>
        </div>
    </>
  );

  return (
    <article className="rounded-[1rem] border border-line bg-white shadow-[0_6px_22px_rgba(19,43,35,0.045)]">
      {hasTranscript ? (
        <button
          type="button"
          onClick={onToggle}
          className="w-full p-4 text-left"
          aria-expanded={expanded}
          aria-controls={transcriptId}
        >
          {summary}
        </button>
      ) : (
        <div className="w-full p-4 text-left">
          {summary}
        </div>
      )}

      {expanded &&
        hasTranscript && (
          <div id={transcriptId} className="border-t border-line bg-surface-subtle p-4">
            <p className="mb-3 text-[0.62rem] font-bold uppercase tracking-[0.12em] text-brand">Conversation transcript</p>
              <TranscriptPanel
                transcript={
                  call.transcript!
                }
              />
          </div>
        )}
    </article>
  );
}
