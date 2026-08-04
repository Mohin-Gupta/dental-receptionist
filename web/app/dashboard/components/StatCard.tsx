import { ElementType } from 'react';

export interface StatCardProps {
  label: string;
  value: number;
  icon: ElementType;
  tone: 'brand' | 'info' | 'success' | 'warm';
  context: string;
}

const toneClasses: Record<StatCardProps['tone'], { icon: string; ornament: string }> = {
  brand: {
    icon: 'border-[#cce4dc] bg-brand-soft text-brand-dark',
    ornament: 'bg-[#d8eee7]',
  },
  info: {
    icon: 'border-[#cee2e8] bg-info-soft text-info',
    ornament: 'bg-[#d9eaf0]',
  },
  success: {
    icon: 'border-[#cfe7dd] bg-success-soft text-success',
    ornament: 'bg-[#dcefe7]',
  },
  warm: {
    icon: 'border-[#eedfbe] bg-warning-soft text-warning',
    ornament: 'bg-[#f2e5c9]',
  },
};

export default function StatCard({
  label,
  value,
  icon: Icon,
  tone,
  context,
}: StatCardProps) {
  const styles = toneClasses[tone];

  return (
    <article className="group relative min-h-[154px] overflow-hidden rounded-[1.1rem] border border-line bg-surface p-5 shadow-[var(--shadow-sm)] transition duration-200 hover:-translate-y-0.5 hover:border-line-strong hover:shadow-[var(--shadow-md)]">
      <span
        className={`absolute -right-8 -top-10 h-28 w-28 rounded-full opacity-35 blur-2xl transition-opacity group-hover:opacity-55 ${styles.ornament}`}
        aria-hidden="true"
      />
      <div className="relative flex items-start justify-between gap-4">
        <div>
          <p className="text-[0.74rem] font-semibold text-muted">{label}</p>
          <p className="mt-3 text-[2rem] font-semibold leading-none tracking-[-0.055em] text-ink">
            {value.toLocaleString()}
          </p>
        </div>

        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[0.82rem] border ${styles.icon}`}>
          <Icon className="h-[1.05rem] w-[1.05rem]" aria-hidden="true" />
        </span>
      </div>

      <div className="relative mt-5 flex items-center gap-2">
        <span className="h-px w-5 bg-line-strong" aria-hidden="true" />
        <p className="text-[0.65rem] font-medium text-muted">{context}</p>
      </div>
    </article>
  );
}
