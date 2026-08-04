import {
  Clock,
  CheckCircle,
  XCircle,
  AlertCircle,
} from 'lucide-react';

interface StatusConfigItem {
  className: string;
  icon: React.ElementType;
}

const STATUS_CONFIG: Record<
  string,
  StatusConfigItem
> = {
  confirmed: {
    className: 'status-success',
    icon: CheckCircle,
  },

  scheduled: {
    className: 'status-info',
    icon: Clock,
  },

  cancelled: {
    className: 'status-danger',
    icon: XCircle,
  },

  completed: {
    className: 'status-neutral',
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
    <span
      className={`status-pill ${config.className}`}
    >
      <Icon
        className="h-3 w-3"
        aria-hidden="true"
      />

      <span className="capitalize">
        {status}
      </span>
    </span>
  );
}
