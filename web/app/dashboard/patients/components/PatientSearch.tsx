import { Search } from 'lucide-react';

interface Props {
  value: string;
  onChange: (
    value: string
  ) => void;
  onSearchStart: () => void;
}

export default function PatientSearch({
  value,
  onChange,
  onSearchStart,
}: Props) {
  return (
    <div className="relative w-full md:w-64">
      <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />

      <input
        type="text"
        placeholder="Search name or phone..."
        value={value}
        onChange={(e) => {
          onSearchStart();
          onChange(
            e.target.value
          );
        }}
        className="w-full pl-9 pr-4 py-2 text-sm bg-gray-800 border border-gray-700 text-gray-200 placeholder-gray-500 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    </div>
  );
}