'use client';

import {
  useEffect,
  useState,
} from 'react';
import { Clock3 } from 'lucide-react';

interface Props {
  timezone: string;
}

export default function TimezonePreview({
  timezone,
}: Props) {
  const [now, setNow] =
    useState(
      new Date()
    );

  useEffect(() => {
    const interval =
      setInterval(() => {
        setNow(
          new Date()
        );
      }, 1000);

    return () =>
      clearInterval(
        interval
      );
  }, []);

  let formatted = '';

  try {
    formatted =
      new Intl.DateTimeFormat(
        'en-US',
        {
          timeZone:
            timezone,
          weekday:
            'short',
          hour:
            'numeric',
          minute:
            '2-digit',
          second:
            '2-digit',
          hour12:
            true,
        }
      ).format(now);
  } catch {
    formatted =
      'Invalid timezone';
  }

  return (
    <p className="mt-2 inline-flex items-center gap-2 rounded-lg bg-brand-softer px-2.5 py-1.5 text-[0.7rem] font-medium text-muted">
      <Clock3 className="h-3.5 w-3.5 text-brand" aria-hidden="true" />
      Current time in this zone:{' '}
      <span className="font-bold text-brand-dark">
        {formatted}
      </span>
    </p>
  );
}
