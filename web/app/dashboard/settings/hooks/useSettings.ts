import { useEffect, useState } from 'react';

import api, {
  BranchSettings,
  ClinicSettings,
  OrganizationSettings,
} from '@/lib/api';
import { useAuth } from '@/lib/auth';

export default function useSettings() {
  const {
    activeOrganizationId,
    activeClinicId,
    canManageSettings,
    organizationRole,
  } = useAuth();

  const [form, setForm] =
    useState<ClinicSettings | null>(
      null
    );

  const [loading, setLoading] =
    useState(true);

  const [saving, setSaving] =
    useState(false);

  const [saved, setSaved] =
    useState(false);

  const loadSettings =
    async () => {
      setLoading(true);

      try {
        const response =
          await api.get<ClinicSettings>(
            '/dashboard/settings'
          );

        setForm(response.data);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };

  useEffect(() => {
    void loadSettings();
  }, [activeOrganizationId, activeClinicId]);

  const updateBranch = <
    K extends keyof BranchSettings
  >(
    key: K,
    value: BranchSettings[K]
  ) => {
    setForm((prev) =>
      prev
        ? {
            ...prev,
            clinic: {
              ...prev.clinic,
              [key]: value,
            },
          }
        : prev
    );
  };

  const updateOrganization = <
    K extends keyof OrganizationSettings
  >(
    key: K,
    value: OrganizationSettings[K]
  ) => {
    setForm((prev) =>
      prev
        ? {
            ...prev,
            organization: {
              ...prev.organization,
              [key]: value,
            },
          }
        : prev
    );
  };

  const handleSave =
    async () => {
      if (!form) return;

      setSaving(true);

      try {
        await api.patch(
          '/dashboard/settings',
          organizationRole === 'owner'
            ? {
                organization:
                  form.organization,
                clinic: form.clinic,
              }
            : {
                clinic: form.clinic,
              }
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

  return {
    form,
    setForm,

    loading,

    saving,
    saved,

    canEditOrganization:
      organizationRole === 'owner',
    canManageDoctors:
      canManageSettings,
    updateBranch,
    updateOrganization,
    refreshSettings: loadSettings,
    handleSave,
  };
}
