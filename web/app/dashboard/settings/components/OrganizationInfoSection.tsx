import {
  OrganizationSettings,
} from '@/lib/api';

import Field from './Field';
import Section from './Section';
import { Building2, LockKeyhole } from 'lucide-react';

interface Props {
  form: OrganizationSettings;
  canEdit: boolean;
  update: <
    K extends keyof OrganizationSettings
  >(
    key: K,
    value: OrganizationSettings[K]
  ) => void;
}

export default function OrganizationInfoSection({
  form,
  canEdit,
  update,
}: Props) {
  return (
    <Section
      id="organization-settings"
      title="Organization profile"
      description="The shared identity used across every clinic in your organization."
      eyebrow="Organization"
      icon={Building2}
    >
      {!canEdit && (
        <div className="alert-info mb-5">
          <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>Only the organization owner can update these details. You can still review the current profile.</p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field
          label="Organization name"
          value={form.name}
          disabled={!canEdit}
          onChange={(value) =>
            update('name', value)
          }
        />

        <Field
          label="Phone number"
          value={form.phone ?? ''}
          disabled={!canEdit}
          onChange={(value) =>
            update(
              'phone',
              value || null
            )
          }
        />

        <Field
          label="Email"
          value={form.email ?? ''}
          disabled={!canEdit}
          onChange={(value) =>
            update(
              'email',
              value || null
            )
          }
        />

        <Field
          label="Website"
          value={form.website ?? ''}
          disabled={!canEdit}
          onChange={(value) =>
            update(
              'website',
              value || null
            )
          }
        />

        <div className="md:col-span-2">
          <label htmlFor="organization-about" className="ui-label">
            About
          </label>

          <textarea
            id="organization-about"
            value={form.about ?? ''}
            onChange={(event) =>
              update(
                'about',
                event.target.value ||
                  null
              )
            }
            disabled={!canEdit}
            rows={3}
            className="ui-textarea min-h-28 resize-none"
          />
        </div>
      </div>
    </Section>
  );
}
