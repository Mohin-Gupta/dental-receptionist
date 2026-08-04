import {
  Save,
  CheckCircle,
} from 'lucide-react';

interface Props {
  saving: boolean;
  saved: boolean;
  onClick: () => void;
}

export default function SaveButton({
  saving,
  saved,
  onClick,
}: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={saving}
      className={`w-full md:w-auto ${
        saved
          ? 'btn-secondary border-[#cce7dc] bg-success-soft text-success'
          : 'btn-primary'
      }`}
      aria-live="polite"
    >
      {saved ? (
        <>
          <CheckCircle className="h-4 w-4" aria-hidden="true" />
          Saved
        </>
      ) : (
        <>
          <Save className="h-4 w-4" aria-hidden="true" />

          {saving
            ? 'Saving...'
            : 'Save changes'}
        </>
      )}
    </button>
  );
}
