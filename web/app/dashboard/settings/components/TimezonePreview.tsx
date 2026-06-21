'use client';

import {
  useEffect,
  useState,
} from 'react';

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
    <p className="text-xs text-gray-500 mt-1.5">
      Current time in this
      zone:{' '}
      <span className="text-gray-300">
        {formatted}
      </span>
    </p>
  );
}