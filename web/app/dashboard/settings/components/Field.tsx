import { useId } from 'react';
import { LockKeyhole } from 'lucide-react';

interface FieldProps {
  label: string;
  value: string;
  onChange?: (
    value: string
  ) => void;
  disabled?: boolean;
  type?: string;
  placeholder?: string;
  helper?: string;
}

export default function Field({
  label,
  value,
  onChange,
  disabled = false,
  type = 'text',
  placeholder = '',
  helper,
}: FieldProps) {
  const inputId = useId();

  return (
    <div>
      <label htmlFor={inputId} className="ui-label">
        {label}
      </label>

      <div className="relative">
        <input
          id={inputId}
          type={type}
          value={value}
          onChange={(e) =>
            onChange?.(
              e.target.value
            )
          }
          disabled={disabled}
          placeholder={placeholder}
          className={`ui-input ${disabled ? 'pr-10' : ''}`}
          aria-describedby={helper ? `${inputId}-help` : undefined}
        />
        {disabled && (
          <LockKeyhole className="pointer-events-none absolute right-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" aria-hidden="true" />
        )}
      </div>
      {helper && <p id={`${inputId}-help`} className="ui-help">{helper}</p>}
    </div>
  );
}
