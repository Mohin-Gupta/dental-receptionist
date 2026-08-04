interface Props {
  transcript: string;
}

export default function TranscriptPanel({
  transcript,
}: Props) {
  return (
    <div className="rounded-xl border border-line bg-white p-4 shadow-[inset_3px_0_0_#d6ebe5] sm:p-5">
      <pre className="whitespace-pre-wrap break-words font-mono text-[0.72rem] leading-6 text-ink-soft">
        {transcript}
      </pre>
    </div>
  );
}
