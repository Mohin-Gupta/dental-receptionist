'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';

export default function SettingsPage() {
  const [form, setForm] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.get('/dashboard/settings')
      .then(r => setForm(r.data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.patch('/dashboard/settings', form);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const update = (key: string, value: any) => {
    setForm((prev: any) => ({ ...prev, [key]: value }));
  };

  if (loading || !form) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Settings</h1>
          <p className="text-sm text-gray-500 mt-1">Clinic and doctor information</p>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {saving ? 'Saving...' : saved ? 'Saved ✓' : 'Save changes'}
        </button>
      </div>

      <div className="space-y-6">

        {/* Clinic info */}
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Clinic Information</h2>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Clinic name" value={form.name} onChange={v => update('name', v)} />
            <Field label="Phone number" value={form.phone} onChange={v => update('phone', v)} disabled />
            <Field label="Email" value={form.clinicEmail ?? ''} onChange={v => update('clinicEmail', v)} />
            <Field label="Website" value={form.clinicWebsite ?? ''} onChange={v => update('clinicWebsite', v)} />
            <div className="col-span-2">
              <Field label="Address" value={form.clinicAddress ?? ''} onChange={v => update('clinicAddress', v)} />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-600 mb-1.5">About</label>
              <textarea
                value={form.clinicAbout ?? ''}
                onChange={e => update('clinicAbout', e.target.value)}
                rows={3}
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              />
            </div>
          </div>
        </div>

        {/* Doctor info */}
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Doctor Information</h2>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Doctor name" value={form.doctorName ?? ''} onChange={v => update('doctorName', v)} />
            <Field label="Doctor phone" value={form.doctorPhone ?? ''} onChange={v => update('doctorPhone', v)} />
            <Field label="Qualification" value={form.doctorQualification ?? ''} onChange={v => update('doctorQualification', v)} />
            <Field label="Specialty" value={form.doctorSpecialty ?? ''} onChange={v => update('doctorSpecialty', v)} />
            <Field label="Years of experience" value={form.doctorYOE?.toString() ?? ''} onChange={v => update('doctorYOE', v)} type="number" />
          </div>
        </div>

        {/* Business hours */}
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">Business Hours</h2>
          <div className="space-y-3">
            {['mon','tue','wed','thu','fri','sat','sun'].map(day => {
              const hours = form.businessHours?.[day];
              return (
                <div key={day} className="flex items-center gap-4">
                  <span className="text-sm text-gray-600 w-10 capitalize">{day}</span>
                  {hours === null ? (
                    <span className="text-sm text-gray-400">Closed</span>
                  ) : (
                    <>
                      <input
                        type="time"
                        value={hours?.open ?? '09:00'}
                        onChange={e => update('businessHours', {
                          ...form.businessHours,
                          [day]: { ...hours, open: e.target.value }
                        })}
                        className="text-sm border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                      <span className="text-gray-400 text-sm">to</span>
                      <input
                        type="time"
                        value={hours?.close ?? '18:00'}
                        onChange={e => update('businessHours', {
                          ...form.businessHours,
                          [day]: { ...hours, close: e.target.value }
                        })}
                        className="text-sm border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>

      </div>
    </div>
  );
}

function Field({ label, value, onChange, disabled = false, type = 'text' }: {
  label: string; value: string; onChange: (v: string) => void;
  disabled?: boolean; type?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1.5">{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-400"
      />
    </div>
  );
}