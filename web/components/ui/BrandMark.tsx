import { cn } from '@/lib/cn';

interface BrandMarkProps {
  inverted?: boolean;
  compact?: boolean;
  className?: string;
}

export default function BrandMark({
  inverted = false,
  compact = false,
  className,
}: BrandMarkProps) {
  return (
    <div
      className={cn('inline-flex items-center gap-3', className)}
      role="img"
      aria-label="Maya clinic intelligence"
    >
      <span
        className={cn(
          'relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[13px] border shadow-[0_8px_24px_rgba(6,61,53,0.16)]',
          inverted
            ? 'border-white/15 bg-white text-[#0d5d53]'
            : 'border-[#0c665b] bg-[#137267] text-white'
        )}
        aria-hidden="true"
      >
        <svg viewBox="0 0 32 32" className="h-6 w-6" fill="none">
          <path
            d="M5.5 17.25h3.15c1.75 0 2.35-5.3 4.05-5.3 1.8 0 2.05 8.1 3.95 8.1 1.72 0 2.25-5.4 4-5.4h5.85"
            stroke="currentColor"
            strokeWidth="2.35"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="23.65" cy="10.15" r="1.7" fill="currentColor" opacity="0.72" />
        </svg>
        <span className="absolute inset-x-1.5 bottom-1 h-px rounded-full bg-current opacity-15" />
      </span>

      {!compact && (
        <span className="flex flex-col leading-none">
          <span
            className={cn(
              'font-display text-[1.48rem] font-medium tracking-[-0.045em]',
              inverted ? 'text-white' : 'text-[#17231f]'
            )}
          >
            Maya
          </span>
          <span
            className={cn(
              'mt-1 text-[0.56rem] font-bold uppercase tracking-[0.2em]',
              inverted ? 'text-[#a9c6bc]' : 'text-[#6c7c76]'
            )}
          >
            Clinic intelligence
          </span>
        </span>
      )}
    </div>
  );
}
