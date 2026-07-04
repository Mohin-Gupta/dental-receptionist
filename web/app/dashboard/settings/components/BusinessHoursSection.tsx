import { BranchSettings } from '@/lib/api';
import { createDefaultBusinessHours } from '../utils/settingsHelpers';
import Section from './Section';
import DAY_LABELS from '../constants/dayLabels';

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
    <Section title="Business Hours">
      <p className="text-xs text-gray-500 mb-4">
        Hours below are interpreted
        in the clinic timezone
        selected above.
      </p>

      <div className="space-y-4">
        {DAYS.map((day) => {
          const hours =
            form.businessHours?.[
              day
            ];

          return (
            <div
              key={day}
              className="flex flex-col md:flex-row md:items-center gap-3 md:gap-4"
            >
              <span className="text-sm text-gray-300 md:w-24">
                {
                  DAY_LABELS[
                    day
                  ]
                }
              </span>

              {hours == null ? (
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-sm text-gray-600">
                    Closed
                  </span>

                  <button
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
                    className="text-xs text-blue-400 hover:text-blue-300"
                  >
                    Set hours
                  </button>
                </div>
              ) : (
                <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                  <input
                    type="time"
                    value={
                      hours.open
                    }
                    onChange={(
                      e
                    ) =>
                      update(
                        'businessHours',
                        {
                          ...form.businessHours,
                          [day]:
                            {
                              ...hours,
                              open:
                                e
                                  .target
                                  .value,
                            },
                        }
                      )
                    }
                    className="text-sm bg-gray-800 border border-gray-700 text-gray-200 rounded-lg px-3 py-2"
                  />

                  <span className="hidden sm:block text-gray-600 text-sm">
                    to
                  </span>

                  <input
                    type="time"
                    value={
                      hours.close
                    }
                    onChange={(
                      e
                    ) =>
                      update(
                        'businessHours',
                        {
                          ...form.businessHours,
                          [day]:
                            {
                              ...hours,
                              close:
                                e
                                  .target
                                  .value,
                            },
                        }
                      )
                    }
                    className="text-sm bg-gray-800 border border-gray-700 text-gray-200 rounded-lg px-3 py-2"
                  />

                  <button
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
                    className="text-xs text-red-400 hover:text-red-300 text-left"
                  >
                    Set closed
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
