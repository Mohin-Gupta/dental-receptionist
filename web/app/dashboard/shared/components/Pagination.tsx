import {
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';

interface Props {
  page: number;
  totalPages: number;
  total: number;
  onPrevious: () => void;
  onNext: () => void;
}

export default function Pagination({
  page,
  totalPages,
  total,
  onPrevious,
  onNext,
}: Props) {
  if (totalPages <= 1) return null;

  return (
    <nav
      className="flex flex-col items-center justify-between gap-3 border-t border-line bg-[#fbfcfc] px-4 py-4 sm:flex-row sm:px-5"
      aria-label="Pagination"
    >
      <p className="text-center text-[0.7rem] font-medium text-muted sm:text-left" aria-live="polite">
        Page <span className="font-bold text-ink-soft">{page}</span> of{' '}
        <span className="font-bold text-ink-soft">{totalPages}</span>
        <span className="mx-2 text-line-strong" aria-hidden="true">/</span>
        {total.toLocaleString()} records
      </p>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onPrevious}
          disabled={page === 1}
          className="btn-secondary min-h-9 px-3 py-2 text-[0.7rem]"
          aria-label={`Go to page ${Math.max(1, page - 1)}`}
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Previous
        </button>

        <button
          type="button"
          onClick={onNext}
          disabled={page === totalPages}
          className="btn-secondary min-h-9 px-3 py-2 text-[0.7rem]"
          aria-label={`Go to page ${Math.min(totalPages, page + 1)}`}
        >
          Next
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}
