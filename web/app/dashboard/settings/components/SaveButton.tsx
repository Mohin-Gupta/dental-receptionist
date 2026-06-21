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
      onClick={onClick}
      disabled={saving}
      className={`w-full md:w-auto flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
        saved
          ? 'bg-emerald-600 text-white'
          : 'bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50'
      }`}
    >
      {saved ? (
        <>
          <CheckCircle className="w-4 h-4" />
          Saved
        </>
      ) : (
        <>
          <Save className="w-4 h-4" />

          {saving
            ? 'Saving...'
            : 'Save changes'}
        </>
      )}
    </button>
  );
}