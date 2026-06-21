import {
  Clock,
  CheckCircle,
  XCircle,
  AlertCircle,
} from 'lucide-react';

interface StatusConfigItem {
  color: string;
  bg: string;
  icon: React.ElementType;
}

const STATUS_CONFIG: Record<
  string,
  StatusConfigItem
> = {
  confirmed: {
    color: 'text-emerald-400',
    bg: 'bg-emerald-400/10',
    icon: CheckCircle,
  },

  scheduled: {
    color: 'text-blue-400',
    bg: 'bg-blue-400/10',
    icon: Clock,
  },

  cancelled: {
    color: 'text-red-400',
    bg: 'bg-red-400/10',
    icon: XCircle,
  },

  completed: {
    color: 'text-gray-400',
    bg: 'bg-gray-400/10',
    icon: AlertCircle,
  },
};

interface Props {
  status: string;
}

export default function StatusBadge({
  status,
}: Props) {
  const config =
    STATUS_CONFIG[status] ??
    STATUS_CONFIG.completed;

  const Icon = config.icon;

  return (
    <div
      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full ${config.bg} w-fit`}
    >
      <Icon
        className={`w-3 h-3 ${config.color}`}
      />

      <span
        className={`text-xs font-medium capitalize ${config.color}`}
      >
        {status}
      </span>
    </div>
  );
}