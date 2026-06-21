import { ElementType } from 'react';

export interface StatCardProps {
  label: string;
  value: number;
  icon: ElementType;
  color: string;
  bg: string;
  border: string;
}

export default function StatCard({
  label,
  value,
  icon: Icon,
  color,
  bg,
  border,
}: StatCardProps) {
  return (
    <div className={`bg-gray-900 rounded-xl border ${border} p-5`}>
      <div className="flex items-center justify-between mb-4">
        <span className="text-sm text-gray-400">
          {label}
        </span>

        <div
          className={`w-9 h-9 rounded-lg ${bg} flex items-center justify-center`}
        >
          <Icon
            className={`w-4 h-4 ${color}`}
          />
        </div>
      </div>

      <p
        className={`text-3xl font-bold ${color}`}
      >
        {value}
      </p>
    </div>
  );
}