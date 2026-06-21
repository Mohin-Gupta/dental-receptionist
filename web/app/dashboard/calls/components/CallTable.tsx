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
    <div className="hidden md:block">
      <div className="grid grid-cols-5 px-6 py-3 border-b border-gray-800 text-xs font-medium text-gray-500 uppercase tracking-wider">
        <span className="col-span-2">
          Phone Number
        </span>

        <span>Duration</span>

        <span>Outcome</span>

        <span>Date & Time</span>
      </div>

      <div className="divide-y divide-gray-800">
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

          return (
            <div key={call.id}>
              <div
                className="grid grid-cols-5 px-6 py-4 hover:bg-gray-800/50 transition-colors items-center cursor-pointer"
                onClick={() =>
                  onToggle(call.id)
                }
              >
                <div className="col-span-2 flex items-center gap-3">
                  <div
                    className={`w-9 h-9 rounded-full flex items-center justify-center ${
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
                    <p className="text-sm font-medium text-white font-mono">
                      {
                        displayPhone
                      }
                    </p>

                    <p className="text-xs text-gray-500 capitalize">
                      {
                        call.direction
                      }{' '}
                      call
                    </p>
                  </div>
                </div>

                <span className="text-sm text-gray-300">
                  {formatDuration(
                    call.durationSecs
                  )}
                </span>

                <div>
                  {call.outcome ? (
                    <span className="text-xs px-2 py-1 rounded-full bg-gray-800 text-gray-300 capitalize">
                      {
                        call.outcome
                      }
                    </span>
                  ) : (
                    <span className="text-xs text-gray-600">
                      —
                    </span>
                  )}
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-400">
                    {formatDateTime(
                      call.createdAt,
                      timezone
                    )}
                  </span>

                  {hasTranscript &&
                    (isExpanded ? (
                      <ChevronUp className="w-4 h-4 text-gray-500" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-gray-500" />
                    ))}
                </div>
              </div>

              {isExpanded &&
                hasTranscript && (
                  <div className="px-6 pb-5 bg-gray-950/50 border-t border-gray-800">
                    <p className="text-xs font-medium text-gray-500 pt-4 mb-3 uppercase tracking-wider">
                      Transcript
                    </p>

                    <div className="max-h-96 overflow-y-auto">
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
        })}
      </div>
    </div>
  );
}