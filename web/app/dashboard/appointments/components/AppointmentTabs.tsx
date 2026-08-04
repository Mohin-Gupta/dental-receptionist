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
    <div className="mb-5 overflow-x-auto pb-0.5">
      <div className="segmented-control" role="tablist" aria-label="Appointment status">
        {tabs.map((tab) => {
          const Icon = tab.icon;

          return (
            <button
              type="button"
              key={tab.key}
              role="tab"
              aria-selected={activeTab === tab.key}
              onClick={() =>
                onChange(
                  tab.key as TabType
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
    </div>
  );
}
