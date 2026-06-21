import { LucideIcon } from 'lucide-react';

interface Props {
  icon: LucideIcon;
  message: string;
}

export default function EmptyState({
  icon: Icon,
  message,
}: Props) {
  return (
    <div className="py-20 text-center">
      <Icon className="w-8 h-8 text-gray-700 mx-auto mb-3" />

      <p className="text-sm text-gray-500">
        {message}
      </p>
    </div>
  );
}