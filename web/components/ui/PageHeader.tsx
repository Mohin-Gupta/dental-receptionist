import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

interface PageHeaderProps {
  eyebrow: string;
  title: string;
  description?: ReactNode;
  icon?: LucideIcon;
  actions?: ReactNode;
}

export default function PageHeader({
  eyebrow,
  title,
  description,
  icon: Icon,
  actions,
}: PageHeaderProps) {
  return (
    <header className="page-header">
      <div>
        <p className="page-eyebrow">
          {Icon && <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
          {eyebrow}
        </p>
        <h1 className="page-title">{title}</h1>
        {description && <div className="page-description">{description}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
