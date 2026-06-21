import { ClinicSettings } from '@/lib/api';
import { parseYearsOfExperience } from '../utils/settingsHelpers';
import Field from './Field';
import Section from './Section';

interface Props {
  form: ClinicSettings;
  update: <
    K extends keyof ClinicSettings
  >(
    key: K,
    value: ClinicSettings[K]
  ) => void;
}

export default function DoctorInfoSection({
  form,
  update,
}: Props) {
  return (
    <Section title="Doctor Information">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field
          label="Doctor name"
          value={
            form.doctorName ??
            ''
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
            form.doctorPhone ??
            ''
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
              parseYearsOfExperience(v) as never
            )
          }
        />
      </div>
    </Section>
  );
}