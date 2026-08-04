import { BranchSettings } from '@/lib/api';

import Field from './Field';
import Section from './Section';
import TimezonePreview from './TimezonePreview';

import { TIMEZONE_OPTIONS } from '../constants/timezoneOptions';
import { MapPinned, TriangleAlert } from 'lucide-react';

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
    <Section
      id="clinic-settings"
      title="Clinic information"
      description="Patient-facing contact details, location context, and local scheduling timezone."
      eyebrow="Location profile"
      icon={MapPinned}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
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
          helper="This clinic number is managed when the location is created."
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
          <label htmlFor="clinic-timezone" className="ui-label">
            Clinic timezone
          </label>

          <select
            id="clinic-timezone"
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
            className="ui-select"
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

          <div className="alert-warning mt-3">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p>
              Changing this affects all future appointment reminders, SMS timing, and Google Calendar sync.
              Existing appointments keep their original scheduled times.
            </p>
          </div>
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
          <label htmlFor="clinic-about" className="ui-label">
            About the clinic
          </label>

          <textarea
            id="clinic-about"
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
            className="ui-textarea min-h-32 resize-none"
          />
        </div>
      </div>
    </Section>
  );
}
