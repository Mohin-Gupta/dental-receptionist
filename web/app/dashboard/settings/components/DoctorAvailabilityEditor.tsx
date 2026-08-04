'use client';

import { useEffect, useState } from 'react';
import axios from 'axios';

import api, { DoctorAvailability, WeeklyHours } from '@/lib/api';
import {
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  Clock3,
  RotateCcw,
  Save,
  X,
} from 'lucide-react';

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
      const serverMessage = axios.isAxiosError(err) && typeof err.response?.data?.error === 'string'
        ? err.response.data.error
        : null;
      setError(serverMessage ?? 'Failed to save availability.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mt-4 overflow-hidden rounded-xl border border-[#cfe3dc] bg-brand-softer/60">
      <header className="flex items-start justify-between gap-3 border-b border-[#d7e7e1] bg-white/80 p-4">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand-dark">
            <CalendarClock className="h-4 w-4" aria-hidden="true" />
          </span>
          <div>
            <span className="status-pill status-info mb-1.5">Doctor-specific schedule</span>
            <h4 className="text-xs font-bold text-ink">{doctorName}&apos;s availability</h4>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="icon-button h-8 w-8"
          aria-label={`Close ${doctorName}'s availability editor`}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </header>

      <div className="p-4 sm:p-5">
        <div className="alert-info mb-4">
          <Clock3 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>
            Override this doctor&apos;s hours for the current clinic. Any day left as
            &quot;Use clinic hours&quot; automatically follows the clinic&apos;s own business
            hours, including future changes to them.
          </p>
        </div>

        {loading ? (
          <div className="space-y-2" role="status" aria-label="Loading doctor availability">
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex items-center gap-3 rounded-lg bg-white/70 p-3">
                <span className="skeleton h-3.5 w-20" />
                <span className="skeleton ml-auto h-9 w-48" />
              </div>
            ))}
            <span className="sr-only">Loading doctor availability</span>
          </div>
        ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-white">
          {DAYS.map((day) => {
            const override = draft[day];
            const inherited = data?.inheritedBusinessHours?.[day];
            const hasOverride = override != null;

            return (
              <div
                key={day}
                className="grid gap-3 border-b border-line px-3.5 py-3 last:border-b-0 lg:grid-cols-[8rem_minmax(0,1fr)] lg:items-center"
              >
                <span className="text-xs font-bold text-ink">
                  {DAY_LABELS[day]}
                </span>

                {!hasOverride ? (
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="status-pill status-neutral">Clinic hours</span>
                    <span className="text-[0.72rem] font-medium text-muted">
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
                      className="btn-ghost min-h-8 px-2.5 py-1.5 text-[0.68rem] text-brand"
                    >
                      <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" /> Override
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2.5 xl:flex-row xl:items-center">
                    <span className="status-pill status-info">Override</span>

                    <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 sm:flex">
                      <label htmlFor={`doctor-${doctorId}-${day}-open`} className="sr-only">{DAY_LABELS[day]} opening time for {doctorName}</label>
                      <input
                        id={`doctor-${doctorId}-${day}-open`}
                        type="time"
                        value={override.open}
                        onChange={(e) =>
                          setDraft((prev) => ({
                            ...prev,
                            [day]: { ...override, open: e.target.value },
                          }))
                        }
                        className="ui-input min-w-0 sm:w-[8.5rem]"
                      />

                      <span className="text-[0.7rem] font-medium text-muted">to</span>

                      <label htmlFor={`doctor-${doctorId}-${day}-close`} className="sr-only">{DAY_LABELS[day]} closing time for {doctorName}</label>
                      <input
                        id={`doctor-${doctorId}-${day}-close`}
                        type="time"
                        value={override.close}
                        onChange={(e) =>
                          setDraft((prev) => ({
                            ...prev,
                            [day]: { ...override, close: e.target.value },
                          }))
                        }
                        className="ui-input min-w-0 sm:w-[8.5rem]"
                      />
                    </div>

                    <button
                      type="button"
                      onClick={() =>
                        setDraft((prev) => ({ ...prev, [day]: null }))
                      }
                      className="btn-ghost min-h-8 justify-start px-2.5 py-1.5 text-[0.68rem] text-muted"
                    >
                      <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Use clinic hours
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        )}

        {error && (
          <div className="alert-error mt-4" role="alert">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p>{error}</p>
          </div>
        )}
        {saved && (
          <div className="alert-success mt-4" role="status">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p>Availability saved.</p>
          </div>
        )}

        <div className="mt-4 flex flex-col gap-2 border-t border-[#d7e7e1] pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[0.68rem] leading-5 text-muted">This saves only {doctorName}&apos;s schedule for the current clinic.</p>
          <button
            type="button"
            onClick={save}
            disabled={saving || loading}
            className="btn-primary shrink-0"
          >
            <Save className="h-4 w-4" aria-hidden="true" />
            {saving ? 'Saving...' : 'Save availability'}
          </button>
        </div>
      </div>
    </section>
  );
}
