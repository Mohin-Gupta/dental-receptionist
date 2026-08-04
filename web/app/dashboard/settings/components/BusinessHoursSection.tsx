import { BranchSettings } from '@/lib/api';
import { createDefaultBusinessHours } from '../utils/settingsHelpers';
import Section from './Section';
import DAY_LABELS from '../constants/dayLabels';
import { Clock3, Plus, X } from 'lucide-react';

interface Props {
  form: BranchSettings;

  update: <
    K extends keyof BranchSettings
  >(
    key: K,
    value: BranchSettings[K]
  ) => void;
}

const DAYS = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
] as const;

export default function BusinessHoursSection({
  form,
  update,
}: Props) {
  return (
    <Section
      id="hours-settings"
      title="Business hours"
      description="Set the weekly schedule Maya uses when offering appointment times."
      eyebrow="Availability"
      icon={Clock3}
    >
      <div className="alert-info mb-5">
        <Clock3 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p>Hours below are interpreted in the clinic timezone selected above.</p>
      </div>

      <div className="overflow-hidden rounded-xl border border-line bg-white">
        {DAYS.map((day) => {
          const hours =
            form.businessHours?.[
              day
            ];

          return (
            <div
              key={day}
              className="grid gap-3 border-b border-line px-4 py-3.5 last:border-b-0 md:grid-cols-[8rem_minmax(0,1fr)] md:items-center md:px-5"
            >
              <div className="flex items-center justify-between md:block">
                <span className="text-xs font-bold text-ink">{DAY_LABELS[day]}</span>
                <span className={`status-pill md:hidden ${hours == null ? 'status-neutral' : 'status-success'}`}>
                  {hours == null ? 'Closed' : 'Open'}
                </span>
              </div>

              {hours == null ? (
                <div className="flex flex-wrap items-center gap-3">
                  <span className="status-pill status-neutral hidden md:inline-flex">
                    <span className="status-dot" aria-hidden="true" /> Closed
                  </span>

                  <button
                    type="button"
                    onClick={() =>
                      update(
                        'businessHours',
                        {
                          ...form.businessHours,
                          [day]:
                            createDefaultBusinessHours(),
                        }
                      )
                    }
                    className="btn-ghost min-h-9 px-3 py-2 text-[0.7rem] text-brand"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Set hours
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <span className="status-pill status-success hidden md:inline-flex">
                    <span className="status-dot" aria-hidden="true" /> Open
                  </span>

                  <div className="flex items-center gap-2">
                    <label htmlFor={`business-${day}-open`} className="sr-only">{DAY_LABELS[day]} opening time</label>
                    <input
                      id={`business-${day}-open`}
                      type="time"
                      value={hours.open}
                      onChange={(e) =>
                        update(
                          'businessHours',
                          {
                            ...form.businessHours,
                            [day]: {
                              ...hours,
                              open: e.target.value,
                            },
                          }
                        )
                      }
                      className="ui-input w-[8.5rem]"
                    />

                    <span className="text-[0.7rem] font-medium text-muted">to</span>

                    <label htmlFor={`business-${day}-close`} className="sr-only">{DAY_LABELS[day]} closing time</label>
                    <input
                      id={`business-${day}-close`}
                      type="time"
                      value={hours.close}
                      onChange={(e) =>
                        update(
                          'businessHours',
                          {
                            ...form.businessHours,
                            [day]: {
                              ...hours,
                              close: e.target.value,
                            },
                          }
                        )
                      }
                      className="ui-input w-[8.5rem]"
                    />
                  </div>

                  <button
                    type="button"
                    onClick={() =>
                      update(
                        'businessHours',
                        {
                          ...form.businessHours,
                          [day]:
                            null,
                        }
                      )
                    }
                    className="btn-ghost min-h-9 justify-start px-3 py-2 text-[0.7rem] text-danger"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" /> Set closed
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}
