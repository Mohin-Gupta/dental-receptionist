import { useState } from 'react';

import api, { Doctor } from '@/lib/api';

import Field from './Field';
import Section from './Section';
import DoctorAvailabilityEditor from './DoctorAvailabilityEditor';
import {
  CalendarClock,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  GraduationCap,
  Mail,
  Phone,
  Plus,
  Stethoscope,
} from 'lucide-react';

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

  const [expandedDoctorId, setExpandedDoctorId] =
    useState<string | null>(null);

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
    <Section
      id="doctor-settings"
      title="Doctors"
      description="Manage the clinicians Maya can book and their location-specific availability."
      eyebrow="Care team"
      icon={Stethoscope}
    >
      <div className="space-y-5">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {doctors.length === 0 ? (
            <div className="rounded-xl border border-dashed border-line-strong bg-surface-subtle px-5 py-8 text-center md:col-span-2">
              <span className="empty-illustration mx-auto h-11 w-11">
                <Stethoscope className="h-4 w-4" aria-hidden="true" />
              </span>
              <p className="mt-3 text-xs font-bold text-ink">No doctors assigned yet</p>
              <p className="mt-1 text-[0.7rem] text-muted">Add the first clinician for this location below.</p>
            </div>
          ) : (
            doctors.map((doctor) => (
              <article
                key={doctor.id}
                className={`rounded-xl border border-line bg-white p-4 shadow-[0_5px_18px_rgba(19,43,35,0.035)] ${
                  expandedDoctorId === doctor.id ? 'md:col-span-2' : ''
                }`}
              >
                <div className="flex items-start gap-3">
                  <span className="avatar h-11 w-11 text-sm">{doctor.name.charAt(0).toUpperCase()}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold text-ink">{doctor.name}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {doctor.specialty && (
                        <span className="status-pill status-info">{doctor.specialty}</span>
                      )}
                      {doctor.qualification && (
                        <span className="inline-flex items-center gap-1 text-[0.68rem] font-medium text-muted">
                          <GraduationCap className="h-3.5 w-3.5 text-brand" aria-hidden="true" />
                          {doctor.qualification}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {(doctor.phone || doctor.email) && (
                  <div className="mt-4 grid gap-2 rounded-xl bg-surface-subtle p-3 text-[0.7rem] font-medium text-ink-soft sm:grid-cols-2">
                    {doctor.phone && (
                      <p className="flex items-center gap-2">
                        <Phone className="h-3.5 w-3.5 shrink-0 text-brand" aria-hidden="true" />
                        <span className="truncate">{doctor.phone}</span>
                      </p>
                    )}
                    {doctor.email && (
                      <p className="flex items-center gap-2">
                        <Mail className="h-3.5 w-3.5 shrink-0 text-brand" aria-hidden="true" />
                        <span className="truncate">{doctor.email}</span>
                      </p>
                    )}
                  </div>
                )}

                {canManage && (
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedDoctorId((prev) =>
                        prev === doctor.id ? null : doctor.id
                      )
                    }
                    className="btn-secondary mt-4 min-h-9 px-3 py-2 text-[0.7rem]"
                    aria-expanded={expandedDoctorId === doctor.id}
                  >
                    <CalendarClock className="h-3.5 w-3.5 text-brand" aria-hidden="true" />
                    {expandedDoctorId === doctor.id
                      ? 'Hide availability'
                      : 'Set availability'}
                    {expandedDoctorId === doctor.id ? (
                      <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                  </button>
                )}

                {expandedDoctorId === doctor.id && (
                  <DoctorAvailabilityEditor
                    doctorId={doctor.id}
                    doctorName={doctor.name}
                    onClose={() => setExpandedDoctorId(null)}
                  />
                )}
              </article>
            ))
          )}
        </div>

        {canManage && (
          <div className="surface-card-soft p-4 sm:p-5">
            <div className="mb-4 flex items-center gap-3 border-b border-line pb-4">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-soft text-brand-dark">
                <Plus className="h-4 w-4" aria-hidden="true" />
              </span>
              <div>
                <h3 className="text-xs font-bold text-ink">Add a doctor</h3>
                <p className="mt-0.5 text-[0.7rem] text-muted">Create a clinician profile for this organization.</p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
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
              <div className="alert-error mt-4" role="alert">
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <p>{error}</p>
              </div>
            )}

            <button
              type="button"
              onClick={createDoctor}
              disabled={saving}
              className="btn-primary mt-4"
            >
              {!saving && <Plus className="h-4 w-4" aria-hidden="true" />}
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
