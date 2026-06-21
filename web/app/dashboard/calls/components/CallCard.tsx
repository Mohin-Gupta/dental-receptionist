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

  return (
    <div>
      <div
        onClick={onToggle}
        className="p-4 cursor-pointer"
      >
        <div className="flex items-start justify-between">
          <div className="flex gap-3">
            <div
              className={`w-10 h-10 rounded-full flex items-center justify-center ${
                call.direction ===
                'inbound'
                  ? 'bg-green-600/20'
                  : 'bg-blue-600/20'
              }`}
            >
              {call.direction ===
              'inbound' ? (
                <PhoneIncoming className="w-4 h-4 text-green-400" />
              ) : (
                <PhoneOutgoing className="w-4 h-4 text-blue-400" />
              )}
            </div>

            <div>
              <p className="text-white font-medium font-mono">
                {displayPhone}
              </p>

              <p className="text-xs text-gray-500 capitalize">
                {call.direction} call
              </p>
            </div>
          </div>

          {hasTranscript &&
            (expanded ? (
              <ChevronUp className="w-4 h-4 text-gray-500" />
            ) : (
              <ChevronDown className="w-4 h-4 text-gray-500" />
            ))}
        </div>

        <div className="grid grid-cols-2 gap-4 mt-4 text-sm">
          <div>
            <p className="text-gray-500 text-xs mb-1">
              Duration
            </p>

            <p className="text-gray-300">
              {formatDuration(
                call.durationSecs
              )}
            </p>
          </div>

          <div>
            <p className="text-gray-500 text-xs mb-1">
              Outcome
            </p>

            <p className="text-gray-300 capitalize">
              {call.outcome ?? '—'}
            </p>
          </div>
        </div>

        <div className="mt-4">
          <p className="text-gray-500 text-xs mb-1">
            Date & Time
          </p>

          <p className="text-gray-300 text-sm">
            {formatDateTime(
              call.createdAt,
              timezone
            )}
          </p>
        </div>
      </div>

      {expanded &&
        hasTranscript && (
          <div className="px-4 pb-4">
            <div className="rounded-lg border border-gray-800 bg-gray-950 p-3">
              <TranscriptPanel
                transcript={
                  call.transcript!
                }
              />
            </div>
          </div>
        )}
    </div>
  );
}