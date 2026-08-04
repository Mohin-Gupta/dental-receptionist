import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface SectionCardProps {
  title: string;
  description?: string;
  eyebrow?: string;
  icon?: LucideIcon;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

export default function SectionCard({
  title,
  description,
  eyebrow,
  icon: Icon,
  action,
  children,
  className,
  contentClassName,
}: SectionCardProps) {
  return (
    <section className={cn('surface-card overflow-hidden', className)}>
      <header className="surface-header">
        <div className="flex items-start gap-3">
          {Icon && (
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#d3e6df] bg-brand-softer text-brand">
              <Icon className="h-4 w-4" />
            </span>
          )}
          <div>
            {eyebrow && <p className="section-kicker mb-1">{eyebrow}</p>}
            <h2 className="section-title">{title}</h2>
            {description && <p className="section-description">{description}</p>}
          </div>
        </div>
        {action}
      </header>
      <div className={contentClassName ?? 'p-4 sm:p-5'}>{children}</div>
    </section>
  );
}
