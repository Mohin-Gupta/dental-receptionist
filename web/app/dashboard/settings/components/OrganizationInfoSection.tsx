import {
  OrganizationSettings,
} from '@/lib/api';

import Field from './Field';
import Section from './Section';

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
    <Section title="Organization">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
          <label className="block text-xs font-medium text-gray-400 mb-1.5">
            About
          </label>

          <textarea
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
            className="w-full text-sm bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-600 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none disabled:opacity-50 disabled:cursor-not-allowed"
          />
        </div>
      </div>
    </Section>
  );
}
