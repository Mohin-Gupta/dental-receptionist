import { ReactNode } from 'react';

interface Props {
  title: string;
  children: ReactNode;
}

export default function Section({
  title,
  children,
}: Props) {
  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 md:p-6">
      <h2 className="text-sm font-semibold text-white mb-5">
        {title}
      </h2>

      {children}
    </div>
  );
}