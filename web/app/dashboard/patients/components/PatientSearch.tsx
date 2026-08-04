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
    <div className="relative w-full md:w-80">
      <label htmlFor="patient-search" className="sr-only">Search patients by name or phone</label>
      <Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-brand" aria-hidden="true" />

      <input
        id="patient-search"
        type="text"
        placeholder="Search name or phone..."
        value={value}
        onChange={(e) => {
          onSearchStart();
          onChange(
            e.target.value
          );
        }}
        className="ui-input pl-10 pr-4 shadow-[0_7px_20px_rgba(19,43,35,0.045)]"
      />
    </div>
  );
}
