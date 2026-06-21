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
    <div className="px-4 sm:px-6 py-4 border-t border-gray-800 flex flex-col sm:flex-row items-center justify-between gap-3">
      <span className="text-xs text-gray-500 text-center sm:text-left">
        Page {page} of {totalPages} · {total} records
      </span>

      <div className="flex gap-2">
        <button
          onClick={onPrevious}
          disabled={page === 1}
          className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-300 disabled:opacity-40 hover:bg-gray-800 transition-colors"
        >
          <ChevronLeft className="w-3 h-3" />
          Previous
        </button>

        <button
          onClick={onNext}
          disabled={page === totalPages}
          className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-300 disabled:opacity-40 hover:bg-gray-800 transition-colors"
        >
          Next
          <ChevronRight className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}