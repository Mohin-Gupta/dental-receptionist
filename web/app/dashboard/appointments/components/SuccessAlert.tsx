import { CheckCircle } from 'lucide-react';

interface Props {
  message: string;
}

export default function SuccessAlert({
  message,
}: Props) {
  if (!message) return null;

  return (
    <div className="mb-4 px-4 py-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl flex items-center gap-3">
      <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0" />

      <p className="text-sm text-emerald-300">
        {message}
      </p>
    </div>
  );
}