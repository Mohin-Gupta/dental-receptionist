import { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

interface Props {
  icon: LucideIcon;
  message: string;
  title?: string;
  action?: ReactNode;
  compact?: boolean;
}

export default function EmptyState({
  icon: Icon,
  message,
  title = 'Nothing here yet',
  action,
  compact = false,
}: Props) {
  return (
    <div className={`px-5 text-center ${compact ? 'py-10' : 'py-16 sm:py-20'}`}>
      <span className="empty-illustration mx-auto">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <h3 className="mt-4 text-sm font-semibold tracking-[-0.015em] text-ink">{title}</h3>
      <p className="mx-auto mt-1.5 max-w-sm text-xs leading-6 text-muted">{message}</p>
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}
