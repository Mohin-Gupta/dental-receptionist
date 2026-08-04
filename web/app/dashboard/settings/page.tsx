'use client';

import useSettings from './hooks/useSettings';

import SaveButton from './components/SaveButton';
import OrganizationInfoSection from './components/OrganizationInfoSection';
import ClinicInfoSection from './components/ClinicInfoSection';
import DoctorInfoSection from './components/DoctorInfoSection';
import BusinessHoursSection from './components/BusinessHoursSection';
import PageHeader from '@/components/ui/PageHeader';
import { Building2, Clock3, MapPinned, SlidersHorizontal, Stethoscope } from 'lucide-react';

export default function SettingsPage() {
  const {
    form,
    loading,

    saving,
    saved,

    canEditOrganization,
    canManageDoctors,
    updateBranch,
    updateOrganization,
    refreshSettings,
    handleSave,
  } = useSettings();

  if (loading || !form) {
    return (
      <div className="page-shell" role="status" aria-label="Loading settings">
        <div className="mb-7 space-y-3">
          <div className="skeleton h-3 w-28" />
          <div className="skeleton h-9 w-52" />
          <div className="skeleton h-3.5 w-full max-w-md" />
        </div>
        <div className="space-y-5">
          {[0, 1, 2].map((section) => (
            <div key={section} className="surface-card overflow-hidden">
              <div className="flex items-center gap-3 border-b border-line p-5">
                <span className="skeleton h-9 w-9 rounded-xl" />
                <div className="space-y-2">
                  <div className="skeleton h-3.5 w-32" />
                  <div className="skeleton h-3 w-56" />
                </div>
              </div>
              <div className="grid gap-4 p-5 md:grid-cols-2">
                <span className="skeleton h-11 w-full" />
                <span className="skeleton h-11 w-full" />
              </div>
            </div>
          ))}
        </div>
        <span className="sr-only">Loading settings</span>
      </div>
    );
  }

  return (
    <div className="page-shell">
      <PageHeader
        eyebrow="Clinic configuration"
        title="Settings"
        icon={SlidersHorizontal}
        description="Manage organization, branch, and doctor information."
        actions={(
          <SaveButton
            saving={saving}
            saved={saved}
            onClick={handleSave}
          />
        )}
      />

      <nav className="surface-card mb-5 flex max-w-full items-center gap-1 overflow-x-auto p-1.5" aria-label="Settings sections">
        {[
          { href: '#organization-settings', label: 'Organization', icon: Building2 },
          { href: '#clinic-settings', label: 'Clinic', icon: MapPinned },
          { href: '#doctor-settings', label: 'Doctors', icon: Stethoscope },
          { href: '#hours-settings', label: 'Business hours', icon: Clock3 },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <a
              key={item.href}
              href={item.href}
              className="inline-flex min-h-9 shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-[0.7rem] font-bold text-muted transition-colors hover:bg-brand-softer hover:text-brand-dark"
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              {item.label}
            </a>
          );
        })}
      </nav>

      <div className="space-y-5">
        <OrganizationInfoSection
          form={form.organization}
          canEdit={canEditOrganization}
          update={updateOrganization}
        />

        <ClinicInfoSection
          form={form.clinic}
          update={updateBranch}
        />

        <DoctorInfoSection
          doctors={form.doctors}
          canManage={canManageDoctors}
          onRefresh={refreshSettings}
        />

        <BusinessHoursSection
          form={form.clinic}
          update={updateBranch}
        />
      </div>
    </div>
  );
}
