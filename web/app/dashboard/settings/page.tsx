'use client';

import useSettings from './hooks/useSettings';

import SaveButton from './components/SaveButton';
import ClinicInfoSection from './components/ClinicInfoSection';
import DoctorInfoSection from './components/DoctorInfoSection';
import BusinessHoursSection from './components/BusinessHoursSection';

export default function SettingsPage() {
  const {
    form,
    loading,

    saving,
    saved,

    update,
    handleSave,
  } = useSettings();

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
            Manage clinic and doctor information
          </p>
        </div>

        <SaveButton
          saving={saving}
          saved={saved}
          onClick={handleSave}
        />
      </div>

      <div className="space-y-5">
        <ClinicInfoSection
          form={form}
          update={update}
        />

        <DoctorInfoSection
          form={form}
          update={update}
        />

        <BusinessHoursSection
          form={form}
          update={update}
        />
      </div>
    </div>
  );
}