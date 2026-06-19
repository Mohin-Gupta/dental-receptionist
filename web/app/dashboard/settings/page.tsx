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

// ── Timezone options ──────────────────────────────────────────────────────────
// IANA timezone identifiers grouped by region, covering the zones most
// relevant for international clinic clients. Stored exactly as-is in
// clinic.timezone and consumed by every backend date/time calculation.
const TIMEZONE_OPTIONS: { group: string; zones: { value: string; label: string }[] }[] = [
  {
    group: 'Asia',
    zones: [
      { value: 'Asia/Kolkata', label: 'India — Kolkata (IST, UTC+5:30)' },
      { value: 'Asia/Dubai', label: 'UAE — Dubai (UTC+4:00)' },
      { value: 'Asia/Karachi', label: 'Pakistan — Karachi (UTC+5:00)' },
      { value: 'Asia/Dhaka', label: 'Bangladesh — Dhaka (UTC+6:00)' },
      { value: 'Asia/Singapore', label: 'Singapore (UTC+8:00)' },
      { value: 'Asia/Hong_Kong', label: 'Hong Kong (UTC+8:00)' },
      { value: 'Asia/Tokyo', label: 'Japan — Tokyo (UTC+9:00)' },
      { value: 'Asia/Shanghai', label: 'China — Shanghai (UTC+8:00)' },
      { value: 'Asia/Riyadh', label: 'Saudi Arabia — Riyadh (UTC+3:00)' },
    ],
  },
  {
    group: 'Europe',
    zones: [
      { value: 'Europe/London', label: 'United Kingdom — London (GMT/BST)' },
      { value: 'Europe/Dublin', label: 'Ireland — Dublin (GMT/IST)' },
      { value: 'Europe/Paris', label: 'France — Paris (CET/CEST)' },
      { value: 'Europe/Berlin', label: 'Germany — Berlin (CET/CEST)' },
      { value: 'Europe/Madrid', label: 'Spain — Madrid (CET/CEST)' },
      { value: 'Europe/Rome', label: 'Italy — Rome (CET/CEST)' },
      { value: 'Europe/Amsterdam', label: 'Netherlands — Amsterdam (CET/CEST)' },
      { value: 'Europe/Zurich', label: 'Switzerland — Zurich (CET/CEST)' },
      { value: 'Europe/Moscow', label: 'Russia — Moscow (UTC+3:00)' },
    ],
  },
  {
    group: 'North America',
    zones: [
      { value: 'America/New_York', label: 'US — Eastern (New York)' },
      { value: 'America/Chicago', label: 'US — Central (Chicago)' },
      { value: 'America/Denver', label: 'US — Mountain (Denver)' },
      { value: 'America/Los_Angeles', label: 'US — Pacific (Los Angeles)' },
      { value: 'America/Anchorage', label: 'US — Alaska (Anchorage)' },
      { value: 'America/Toronto', label: 'Canada — Toronto (Eastern)' },
      { value: 'America/Vancouver', label: 'Canada — Vancouver (Pacific)' },
      { value: 'America/Mexico_City', label: 'Mexico — Mexico City' },
    ],
  },
  {
    group: 'Oceania',
    zones: [
      { value: 'Australia/Sydney', label: 'Australia — Sydney (AEST/AEDT)' },
      { value: 'Australia/Melbourne', label: 'Australia — Melbourne (AEST/AEDT)' },
      { value: 'Australia/Perth', label: 'Australia — Perth (AWST)' },
      { value: 'Pacific/Auckland', label: 'New Zealand — Auckland (NZST/NZDT)' },
    ],
  },
  {
    group: 'Africa',
    zones: [
      { value: 'Africa/Lagos', label: 'Nigeria — Lagos (WAT, UTC+1:00)' },
      { value: 'Africa/Johannesburg', label: 'South Africa — Johannesburg (UTC+2:00)' },
      { value: 'Africa/Cairo', label: 'Egypt — Cairo (UTC+2:00)' },
      { value: 'Africa/Nairobi', label: 'Kenya — Nairobi (UTC+3:00)' },
    ],
  },
  {
    group: 'South America',
    zones: [
      { value: 'America/Sao_Paulo', label: 'Brazil — São Paulo' },
      { value: 'America/Buenos_Aires', label: 'Argentina — Buenos Aires' },
      { value: 'America/Bogota', label: 'Colombia — Bogotá' },
    ],
  },
];

// Live preview of current time in the selected timezone — helps the clinic admin
// confirm they picked the right zone before saving.
function TimezonePreview({ timezone }: { timezone: string }) {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  let formatted = '';
  try {
    formatted = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    }).format(now);
  } catch {
    formatted = 'Invalid timezone';
  }

  return (
    <p className="text-xs text-gray-500 mt-1.5">
      Current time in this zone: <span className="text-gray-300">{formatted}</span>
    </p>
  );
}

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
      // PATCH /dashboard/settings → prisma.clinic.update() →
      // every field below (including timezone) is persisted to Postgres,
      // not just local component state.
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

            {/* Timezone selector — this single field drives all reminder timing,
                SMS scheduling, calendar sync, and dashboard display across the
                entire app. Stored as an IANA identifier (e.g. "America/New_York"). */}
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-gray-400 mb-1.5">
                Clinic timezone
              </label>

              <select
                value={form.timezone ?? 'Asia/Kolkata'}
                onChange={(e) => update('timezone', e.target.value)}
                className="w-full text-sm bg-gray-800 border border-gray-700 text-gray-100 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {TIMEZONE_OPTIONS.map((group) => (
                  <optgroup key={group.group} label={group.group}>
                    {group.zones.map((zone) => (
                      <option key={zone.value} value={zone.value}>
                        {zone.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>

              <TimezonePreview timezone={form.timezone ?? 'Asia/Kolkata'} />

              <p className="text-xs text-amber-400/80 mt-2">
                Changing this affects all future appointment reminders, SMS timing, and
                Google Calendar sync. Existing appointments already booked will keep
                their original scheduled times.
              </p>
            </div>

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
          <p className="text-xs text-gray-500 mb-4">
            Hours below are interpreted in the clinic timezone selected above.
          </p>
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