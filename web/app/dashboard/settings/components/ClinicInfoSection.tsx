import { BranchSettings } from '@/lib/api';

import Field from './Field';
import Section from './Section';
import TimezonePreview from './TimezonePreview';

import { TIMEZONE_OPTIONS } from '../constants/timezoneOptions';

interface Props {
  form: BranchSettings;
  update: <
    K extends keyof BranchSettings
  >(
    key: K,
    value: BranchSettings[K]
  ) => void;
}

export default function ClinicInfoSection({
  form,
  update,
}: Props) {
  return (
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
            form.clinicWebsite ?? ''
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
          <label className="block text-xs font-medium text-gray-400 mb-1.5">
            Clinic timezone
          </label>

          <select
            value={
              form.timezone ??
              'Asia/Kolkata'
            }
            onChange={(e) =>
              update(
                'timezone',
                e.target.value
              )
            }
            className="w-full text-sm bg-gray-800 border border-gray-700 text-gray-100 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {TIMEZONE_OPTIONS.map(
              (group) => (
                <optgroup
                  key={group.group}
                  label={
                    group.group
                  }
                >
                  {group.zones.map(
                    (zone) => (
                      <option
                        key={
                          zone.value
                        }
                        value={
                          zone.value
                        }
                      >
                        {
                          zone.label
                        }
                      </option>
                    )
                  )}
                </optgroup>
              )
            )}
          </select>

          <TimezonePreview
            timezone={
              form.timezone ??
              'Asia/Kolkata'
            }
          />

          <p className="text-xs text-amber-400/80 mt-2">
            Changing this
            affects all future
            appointment
            reminders, SMS
            timing, and Google
            Calendar sync.
            Existing
            appointments keep
            their original
            scheduled times.
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
  );
}
