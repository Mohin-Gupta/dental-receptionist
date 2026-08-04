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
    <div className="segmented-control mb-5" role="tablist" aria-label="Call direction">
      {tabs.map((tab) => {
        const Icon = tab.icon;

        return (
          <button
            type="button"
            key={tab.key}
            title={tab.description}
            role="tab"
            aria-selected={activeTab === tab.key}
            onClick={() =>
              onChange(
                tab.key as DirectionTab
              )
            }
            className={`segmented-item ${
              activeTab === tab.key
                ? 'segmented-item-active'
                : ''
            }`}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
