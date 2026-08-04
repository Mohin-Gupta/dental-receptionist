interface Props {
  height?: string;
  label?: string;
}

export default function LoadingState({
  height = 'h-48',
  label = 'Loading records',
}: Props) {
  return (
    <div className={`flex items-center justify-center px-5 ${height}`} role="status" aria-live="polite">
      <div className="flex w-full max-w-sm flex-col items-center gap-4">
        <span className="relative flex h-11 w-11 items-center justify-center rounded-2xl border border-[#d5e6e0] bg-brand-softer shadow-[0_8px_24px_rgba(19,114,103,0.08)]">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-[#b9d8cf] border-t-brand" aria-hidden="true" />
        </span>
        <div className="text-center">
          <p className="text-xs font-semibold text-ink-soft">{label}</p>
          <p className="mt-1 text-[0.68rem] text-muted">Preparing the latest clinic view…</p>
        </div>
      </div>
    </div>
  );
}
