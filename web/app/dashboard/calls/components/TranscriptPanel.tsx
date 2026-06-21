interface Props {
  transcript: string;
}

export default function TranscriptPanel({
  transcript,
}: Props) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
      <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed text-gray-300 font-mono">
        {transcript}
      </pre>
    </div>
  );
}