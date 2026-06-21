import { useEffect, useState } from 'react';

import api, {
  ClinicSettings,
} from '@/lib/api';

export default function useSettings() {
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

  useEffect(() => {
    api
      .get<ClinicSettings>(
        '/dashboard/settings'
      )
      .then((response) => {
        setForm(response.data);
      })
      .catch(console.error)
      .finally(() =>
        setLoading(false)
      );
  }, []);

  const update = <
    K extends keyof ClinicSettings
  >(
    key: K,
    value: ClinicSettings[K]
  ) => {
    setForm((prev) =>
      prev
        ? {
            ...prev,
            [key]: value,
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
          form
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

    update,
    handleSave,
  };
}