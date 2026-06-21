interface FieldProps {
  label: string;
  value: string;
  onChange?: (
    value: string
  ) => void;
  disabled?: boolean;
  type?: string;
  placeholder?: string;
}

export default function Field({
  label,
  value,
  onChange,
  disabled = false,
  type = 'text',
  placeholder = '',
}: FieldProps) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-400 mb-1.5">
        {label}
      </label>

      <input
        type={type}
        value={value}
        onChange={(e) =>
          onChange?.(
            e.target.value
          )
        }
        disabled={disabled}
        placeholder={placeholder}
        className="w-full text-sm bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-600 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
      />
    </div>
  );
}