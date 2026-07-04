import { useState } from 'react';

import api, { Doctor } from '@/lib/api';

import Field from './Field';
import Section from './Section';

interface Props {
  doctors: Doctor[];
  canManage: boolean;
  onRefresh: () => Promise<void>;
}

function emptyDoctorForm() {
  return {
    name: '',
    phone: '',
    email: '',
    qualification: '',
    specialty: '',
    yearsExperience: '',
  };
}

export default function DoctorInfoSection({
  doctors,
  canManage,
  onRefresh,
}: Props) {
  const [form, setForm] =
    useState(emptyDoctorForm);

  const [saving, setSaving] =
    useState(false);

  const [error, setError] =
    useState('');

  const update = (
    key: keyof ReturnType<typeof emptyDoctorForm>,
    value: string
  ) => {
    setForm((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  const createDoctor =
    async () => {
      if (!form.name.trim()) {
        setError('Doctor name is required.');
        return;
      }

      setSaving(true);
      setError('');

      try {
        await api.post('/dashboard/doctors', {
          name: form.name.trim(),
          phone:
            form.phone.trim() || null,
          email:
            form.email.trim() || null,
          qualification:
            form.qualification.trim() ||
            null,
          specialty:
            form.specialty.trim() ||
            null,
          yearsExperience:
            form.yearsExperience.trim()
              ? Number(
                  form.yearsExperience
                )
              : null,
        });

        setForm(emptyDoctorForm());
        await onRefresh();
      } catch (err) {
        console.error(err);
        setError(
          'Failed to save doctor.'
        );
      } finally {
        setSaving(false);
      }
    };

  return (
    <Section title="Doctors">
      <div className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {doctors.length === 0 ? (
            <p className="text-sm text-gray-500 md:col-span-2">
              No doctors are assigned to this branch yet.
            </p>
          ) : (
            doctors.map((doctor) => (
              <div
                key={doctor.id}
                className="rounded-lg border border-gray-800 bg-gray-900/60 p-4"
              >
                <p className="text-sm font-medium text-white">
                  {doctor.name}
                </p>

                <div className="mt-1 space-y-0.5 text-xs text-gray-400">
                  {doctor.specialty && (
                    <p>
                      {doctor.specialty}
                    </p>
                  )}

                  {doctor.qualification && (
                    <p>
                      {
                        doctor.qualification
                      }
                    </p>
                  )}

                  {doctor.phone && (
                    <p>{doctor.phone}</p>
                  )}

                  {doctor.email && (
                    <p>{doctor.email}</p>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {canManage && (
          <div className="rounded-lg border border-gray-800 bg-gray-950/40 p-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field
                label="Doctor name"
                value={form.name}
                onChange={(value) =>
                  update('name', value)
                }
              />

              <Field
                label="Doctor phone"
                value={form.phone}
                onChange={(value) =>
                  update('phone', value)
                }
              />

              <Field
                label="Email"
                value={form.email}
                onChange={(value) =>
                  update('email', value)
                }
              />

              <Field
                label="Qualification"
                value={
                  form.qualification
                }
                onChange={(value) =>
                  update(
                    'qualification',
                    value
                  )
                }
              />

              <Field
                label="Specialty"
                value={form.specialty}
                onChange={(value) =>
                  update(
                    'specialty',
                    value
                  )
                }
              />

              <Field
                label="Years of experience"
                type="number"
                value={
                  form.yearsExperience
                }
                onChange={(value) =>
                  update(
                    'yearsExperience',
                    value
                  )
                }
              />
            </div>

            {error && (
              <p className="mt-3 text-xs text-red-400">
                {error}
              </p>
            )}

            <button
              type="button"
              onClick={createDoctor}
              disabled={saving}
              className="mt-4 px-4 py-2.5 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving
                ? 'Saving...'
                : 'Add Doctor'}
            </button>
          </div>
        )}
      </div>
    </Section>
  );
}
