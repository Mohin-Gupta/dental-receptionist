import {
  PhoneIncoming,
  PhoneOutgoing,
} from 'lucide-react';

import type { DirectionTab } from '../utils/callHelpers';

interface Props {
  activeTab: DirectionTab;
  onChange: (
    tab: DirectionTab
  ) => void;
}

const tabs = [
  {
    key: 'inbound',
    label: 'Inbound',
    icon: PhoneIncoming,
    description:
      'Calls Maya answered from patients',
  },

  {
    key: 'outbound',
    label: 'Outbound',
    icon: PhoneOutgoing,
    description:
      'Reminder calls Maya made',
  },
] as const;

export default function CallTabs({
  activeTab,
  onChange,
}: Props) {
  return (
    <div className="flex gap-1 mb-5 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit overflow-x-auto">
      {tabs.map((tab) => {
        const Icon = tab.icon;

        return (
          <button
            key={tab.key}
            title={tab.description}
            onClick={() =>
              onChange(
                tab.key as DirectionTab
              )
            }
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap ${
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
  );
}