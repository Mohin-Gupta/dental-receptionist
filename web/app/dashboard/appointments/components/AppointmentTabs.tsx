import {
  Clock,
  CheckCircle,
  XCircle,
} from 'lucide-react';

import type { TabType } from '../hooks/useAppointments';

interface Props {
  activeTab: TabType;
  onChange: (tab: TabType) => void;
}

const tabs = [
  {
    key: 'upcoming',
    label: 'Upcoming',
    icon: Clock,
  },

  {
    key: 'past',
    label: 'Past',
    icon: CheckCircle,
  },

  {
    key: 'cancelled',
    label: 'Cancelled',
    icon: XCircle,
  },
] as const;

export default function AppointmentTabs({
  activeTab,
  onChange,
}: Props) {
  return (
    <div className="mb-5 overflow-x-auto">
      <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 min-w-max">
        {tabs.map((tab) => {
          const Icon = tab.icon;

          return (
            <button
              key={tab.key}
              onClick={() =>
                onChange(
                  tab.key as TabType
                )
              }
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
    </div>
  );
}