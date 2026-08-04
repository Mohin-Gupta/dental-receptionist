import { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import SectionCard from '@/components/ui/SectionCard';

interface Props {
  id?: string;
  title: string;
  description?: string;
  eyebrow?: string;
  icon?: LucideIcon;
  children: ReactNode;
}

export default function Section({
  id,
  title,
  description,
  eyebrow,
  icon,
  children,
}: Props) {
  return (
    <div id={id} className="scroll-mt-24">
      <SectionCard
        title={title}
        description={description}
        eyebrow={eyebrow}
        icon={icon}
        contentClassName="p-4 sm:p-6"
      >
        {children}
      </SectionCard>
    </div>
  );
}
