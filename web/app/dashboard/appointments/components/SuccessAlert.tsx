import { CheckCircle } from 'lucide-react';

interface Props {
  message: string;
}

export default function SuccessAlert({
  message,
}: Props) {
  if (!message) return null;

  return (
    <div className="alert-success mb-5" role="status" aria-live="polite">
      <CheckCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />

      <p className="font-medium">
        {message}
      </p>
    </div>
  );
}
