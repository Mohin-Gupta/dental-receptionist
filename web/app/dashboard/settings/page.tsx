'use client';

import { useEffect, useState } from 'react';
import api, { ClinicSettings } from '@/lib/api';
import { Save, CheckCircle } from 'lucide-react';

interface FieldProps {
  label: string;
  value: string;
  onChange?: (v: string) => void;
  disabled?: boolean;
  type?: string;
  placeholder?: string;
}

function Field({
  label,
  value,
  onChange,
  disabled = false,
  type = 'text',
  placeholder = '',
}: FieldProps) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-400 mb-1.5">
        {label}
      </label>

      <input
        type={type}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        className="w-full text-sm bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-600 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
      />
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 md:p-6">
      <h2 className="text-sm font-semibold text-white mb-5">
        {title}
      </h2>

      {children}
    </div>
  );
}

const DAY_LABELS: Record<string, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

export default function SettingsPage() {
  const [form, setForm] =
    useState<ClinicSettings | null>(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api
      .get<ClinicSettings>(
        '/dashboard/settings'
      )
      .then((r) => setForm(r.data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const update = <
    K extends keyof ClinicSettings
  >(
    key: K,
    value: ClinicSettings[K]
  ) =>
    setForm((prev) =>
      prev
        ? {
            ...prev,
            [key]: value,
          }
        : prev
    );

  const handleSave = async () => {
    if (!form) return;

    setSaving(true);

    try {
      await api.patch(
        '/dashboard/settings',
        form
      );

      setSaved(true);

      setTimeout(() => {
        setSaved(false);
      }, 3000);
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  if (loading || !form) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 lg:p-8">
      <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">
            Settings
          </h1>

          <p className="text-sm text-gray-400 mt-1">
            Manage clinic and doctor
            information
          </p>
        </div>

        <button
          onClick={handleSave}
          disabled={saving}
          className={`w-full md:w-auto flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
            saved
              ? 'bg-emerald-600 text-white'
              : 'bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50'
          }`}
        >
          {saved ? (
            <>
              <CheckCircle className="w-4 h-4" />
              Saved
            </>
          ) : (
            <>
              <Save className="w-4 h-4" />
              {saving
                ? 'Saving...'
                : 'Save changes'}
            </>
          )}
        </button>
      </div>

      <div className="space-y-5">
        <Section title="Clinic Information">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field
              label="Clinic name"
              value={form.name}
              onChange={(v) =>
                update('name', v)
              }
            />

            <Field
              label="Phone number"
              value={form.phone}
              disabled
            />

            <Field
              label="Email"
              value={
                form.clinicEmail ?? ''
              }
              onChange={(v) =>
                update(
                  'clinicEmail',
                  v
                )
              }
              placeholder="info@clinic.com"
            />

            <Field
              label="Website"
              value={
                form.clinicWebsite ??
                ''
              }
              onChange={(v) =>
                update(
                  'clinicWebsite',
                  v
                )
              }
              placeholder="www.clinic.com"
            />

            <div className="md:col-span-2">
              <Field
                label="Address"
                value={
                  form.clinicAddress ??
                  ''
                }
                onChange={(v) =>
                  update(
                    'clinicAddress',
                    v
                  )
                }
                placeholder="123 Main St, City, State"
              />
            </div>

            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-gray-400 mb-1.5">
                About the clinic
              </label>

              <textarea
                value={
                  form.clinicAbout ??
                  ''
                }
                onChange={(e) =>
                  update(
                    'clinicAbout',
                    e.target.value
                  )
                }
                rows={4}
                placeholder="Brief description of your clinic..."
                className="w-full text-sm bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-600 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              />
            </div>
          </div>
        </Section>

        <Section title="Doctor Information">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field
              label="Doctor name"
              value={
                form.doctorName ?? ''
              }
              onChange={(v) =>
                update(
                  'doctorName',
                  v
                )
              }
            />

            <Field
              label="Doctor phone"
              value={
                form.doctorPhone ?? ''
              }
              onChange={(v) =>
                update(
                  'doctorPhone',
                  v
                )
              }
            />

            <Field
              label="Qualification"
              value={
                form.doctorQualification ??
                ''
              }
              onChange={(v) =>
                update(
                  'doctorQualification',
                  v
                )
              }
            />

            <Field
              label="Specialty"
              value={
                form.doctorSpecialty ??
                ''
              }
              onChange={(v) =>
                update(
                  'doctorSpecialty',
                  v
                )
              }
            />

            <Field
              label="Years of experience"
              type="number"
              value={
                form.doctorYOE?.toString() ??
                ''
              }
              onChange={(v) =>
                update(
                  'doctorYOE',
                  (parseInt(v) ||
                    null) as never
                )
              }
            />
          </div>
        </Section>

        <Section title="Business Hours">
          <div className="space-y-4">
            {(
              [
                'mon',
                'tue',
                'wed',
                'thu',
                'fri',
                'sat',
                'sun',
              ] as const
            ).map((day) => {
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
                    {DAY_LABELS[day]}
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
                              [day]: {
                                open: '09:00',
                                close:
                                  '17:00',
                              },
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
                        onChange={(e) =>
                          update(
                            'businessHours',
                            {
                              ...form.businessHours,
                              [day]: {
                                ...hours,
                                open:
                                  e.target
                                    .value,
                              },
                            }
                          )
                        }
                        className="text-sm bg-gray-800 border border-gray-700 text-gray-200 rounded-lg px-3 py-2"
                      />

                      <span className="text-gray-600 text-sm hidden sm:block">
                        to
                      </span>

                      <input
                        type="time"
                        value={
                          hours.close
                        }
                        onChange={(e) =>
                          update(
                            'businessHours',
                            {
                              ...form.businessHours,
                              [day]: {
                                ...hours,
                                close:
                                  e.target
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
                              [day]: null,
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
      </div>
    </div>
  );
}