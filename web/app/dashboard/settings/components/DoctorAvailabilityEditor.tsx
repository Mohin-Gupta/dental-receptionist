'use client';

import { useEffect, useState } from 'react';

import api, { DoctorAvailability, WeeklyHours } from '@/lib/api';

import DAY_LABELS from '../constants/dayLabels';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

function formatHours(hours: { open: string; close: string } | null | undefined): string {
  if (!hours) return 'Closed';
  return `${hours.open}\u2013${hours.close}`;
}

interface Props {
  doctorId: string;
  doctorName: string;
  onClose: () => void;
}

export default function DoctorAvailabilityEditor({
  doctorId,
  doctorName,
  onClose,
}: Props) {
  const [data, setData] = useState<DoctorAvailability | null>(null);
  const [draft, setDraft] = useState<WeeklyHours>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');

    api
      .get<DoctorAvailability>(`/dashboard/doctors/${doctorId}/availability`)
      .then((res) => {
        if (cancelled) return;
        setData(res.data);
        setDraft(res.data.availability);
      })
      .catch((err) => {
        console.error(err);
        if (!cancelled) setError('Failed to load availability.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [doctorId]);

  const save = async () => {
    setSaving(true);
    setError('');

    try {
      const res = await api.put<DoctorAvailability>(
        `/dashboard/doctors/${doctorId}/availability`,
        draft
      );
      setData(res.data);
      setDraft(res.data.availability);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      console.error(err);
      setError('Failed to save availability.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-gray-800 bg-gray-950/40 p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-medium text-white">
          {doctorName}&apos;s availability
        </p>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-gray-500 hover:text-gray-300"
        >
          Close
        </button>
      </div>

      <p className="text-xs text-gray-500 mb-4">
        Override this doctor&apos;s hours for the current clinic. Any day left as
        &quot;Use clinic hours&quot; automatically follows the clinic&apos;s own business
        hours, including future changes to them.
      </p>

      {loading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : (
        <div className="space-y-4">
          {DAYS.map((day) => {
            const override = draft[day];
            const inherited = data?.inheritedBusinessHours?.[day];
            const hasOverride = override != null;

            return (
              <div
                key={day}
                className="flex flex-col md:flex-row md:items-center gap-3 md:gap-4"
              >
                <span className="text-sm text-gray-300 md:w-24">
                  {DAY_LABELS[day]}
                </span>

                {!hasOverride ? (
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-sm text-gray-600">
                      Clinic hours: {formatHours(inherited)}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setDraft((prev) => ({
                          ...prev,
                          [day]: {
                            open: inherited?.open ?? '09:00',
                            close: inherited?.close ?? '17:00',
                          },
                        }))
                      }
                      className="text-xs text-blue-400 hover:text-blue-300"
                    >
                      Override
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                    <input
                      type="time"
                      value={override.open}
                      onChange={(e) =>
                        setDraft((prev) => ({
                          ...prev,
                          [day]: { ...override, open: e.target.value },
                        }))
                      }
                      className="text-sm bg-gray-800 border border-gray-700 text-gray-200 rounded-lg px-3 py-2"
                    />

                    <span className="hidden sm:block text-gray-600 text-sm">
                      to
                    </span>

                    <input
                      type="time"
                      value={override.close}
                      onChange={(e) =>
                        setDraft((prev) => ({
                          ...prev,
                          [day]: { ...override, close: e.target.value },
                        }))
                      }
                      className="text-sm bg-gray-800 border border-gray-700 text-gray-200 rounded-lg px-3 py-2"
                    />

                    <button
                      type="button"
                      onClick={() =>
                        setDraft((prev) => ({ ...prev, [day]: null }))
                      }
                      className="text-xs text-red-400 hover:text-red-300 text-left"
                    >
                      Use clinic hours
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
      {saved && <p className="mt-3 text-xs text-green-400">Availability saved.</p>}

      <button
        type="button"
        onClick={save}
        disabled={saving || loading}
        className="mt-4 px-4 py-2.5 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {saving ? 'Saving...' : 'Save availability'}
      </button>
    </div>
  );
}
