'use client';

import axios from 'axios';
import Link from 'next/link';
import { FormEvent, useEffect, useRef, useState } from 'react';
import {
  Building2,
  CheckCircle2,
  Loader2,
  Mail,
  Stethoscope,
} from 'lucide-react';
import api, {
  createIdempotencyKey,
  type OrganizationRegistrationResponse,
} from '@/lib/api';

const countryOptions = [
  { countryCode: 'IN', callingCode: '91', locale: 'en-IN', label: 'India (+91)' },
  { countryCode: 'US', callingCode: '1', locale: 'en-US', label: 'United States (+1)' },
  { countryCode: 'CA', callingCode: '1', locale: 'en-CA', label: 'Canada (+1)' },
  { countryCode: 'GB', callingCode: '44', locale: 'en-GB', label: 'United Kingdom (+44)' },
  { countryCode: 'AU', callingCode: '61', locale: 'en-AU', label: 'Australia (+61)' },
] as const;

const inputClass =
  'w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500';
const termsUrl = process.env.NEXT_PUBLIC_TERMS_URL?.trim();
const privacyUrl = process.env.NEXT_PUBLIC_PRIVACY_URL?.trim();
const legalDocumentsConfigured = Boolean(termsUrl && privacyUrl);

function errorMessage(error: unknown, fallback: string): string {
  return axios.isAxiosError(error)
    ? error.response?.data?.error ?? fallback
    : fallback;
}

export default function RegisterOrganizationPage() {
  const [form, setForm] = useState({
    ownerName: '',
    email: '',
    password: '',
    confirmPassword: '',
    organizationName: '',
    clinicName: '',
    clinicPhone: '',
    timezone: 'Asia/Kolkata',
    countryCode: 'IN',
    defaultCallingCode: '91',
    locale: 'en-IN',
    acceptTerms: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [registered, setRegistered] = useState<OrganizationRegistrationResponse | null>(null);
  const registrationRequest = useRef<{ fingerprint: string; key: string } | null>(null);

  useEffect(() => {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (detected) setForm(current => ({ ...current, timezone: detected }));
  }, []);

  const update = (key: keyof typeof form, value: string | boolean) => {
    setForm(current => ({ ...current, [key]: value }));
  };

  const selectCountry = (countryCode: string) => {
    const country = countryOptions.find(option => option.countryCode === countryCode);
    if (!country) return;
    setForm(current => ({
      ...current,
      countryCode: country.countryCode,
      defaultCallingCode: country.callingCode,
      locale: country.locale,
    }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (form.password !== form.confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (!form.acceptTerms) {
      setError('You must accept the terms and privacy policy');
      return;
    }
    if (!legalDocumentsConfigured) {
      setError('Self-service registration is temporarily unavailable because the legal document links are not configured.');
      return;
    }

    const payload = {
      ownerName: form.ownerName,
      email: form.email,
      password: form.password,
      organizationName: form.organizationName,
      clinicName: form.clinicName,
      clinicPhone: form.clinicPhone,
      timezone: form.timezone,
      countryCode: form.countryCode,
      defaultCallingCode: form.defaultCallingCode,
      locale: form.locale,
      acceptTerms: true as const,
    };
    const fingerprint = JSON.stringify(payload);
    if (!registrationRequest.current || registrationRequest.current.fingerprint !== fingerprint) {
      registrationRequest.current = {
        fingerprint,
        key: createIdempotencyKey('organization-registration'),
      };
    }

    setSubmitting(true);
    try {
      const response = await api.post<OrganizationRegistrationResponse>(
        '/auth/register-organization',
        payload,
        { headers: { 'Idempotency-Key': registrationRequest.current.key } }
      );
      setRegistered(response.data);
    } catch (requestError) {
      setError(errorMessage(requestError, 'Unable to create the organization'));
    } finally {
      setSubmitting(false);
    }
  };

  const resendVerification = async () => {
    setResending(true);
    setError('');
    setNotice('');
    try {
      await api.post(
        '/auth/resend-verification',
        { email: form.email },
        { headers: { 'Idempotency-Key': createIdempotencyKey('verification-resend') } }
      );
      setNotice('A new verification email has been sent.');
    } catch (requestError) {
      setError(errorMessage(requestError, 'Unable to resend the verification email'));
    } finally {
      setResending(false);
    }
  };

  if (registered) {
    return (
      <div className="min-h-screen bg-gray-950 px-4 py-12 flex items-center justify-center">
        <div className="w-full max-w-lg rounded-xl border border-gray-800 bg-gray-900 p-7 text-center shadow-2xl">
          {registered.verificationDeliveryPending ? (
            <Mail className="mx-auto mb-4 h-10 w-10 text-amber-400" />
          ) : (
            <CheckCircle2 className="mx-auto mb-4 h-10 w-10 text-emerald-400" />
          )}
          <h1 className="text-xl font-semibold text-white">Organization created</h1>
          <p className="mt-2 text-sm text-gray-400">
            {registered.verificationDeliveryPending
              ? 'Your workspace is ready, but the first verification email could not be delivered. Retry below.'
              : `We sent a verification link to ${form.email}. Verify your address before signing in.`}
          </p>
          {notice && <p className="mt-4 text-sm text-emerald-400">{notice}</p>}
          {error && <p className="mt-4 text-sm text-red-400">{error}</p>}
          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
            <button
              type="button"
              onClick={resendVerification}
              disabled={resending}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-700 px-4 py-2.5 text-sm font-medium text-gray-200 hover:bg-gray-800 disabled:opacity-50"
            >
              {resending && <Loader2 className="h-4 w-4 animate-spin" />}
              Resend verification
            </button>
            <Link
              href="/sign-in"
              className="rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
            >
              Go to sign in
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 px-4 py-10">
      <form
        onSubmit={submit}
        className="mx-auto w-full max-w-3xl rounded-xl border border-gray-800 bg-gray-900 p-6 shadow-2xl md:p-8"
      >
        <div className="mb-7 flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-600">
            <Building2 className="h-5 w-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-white">Create your clinic workspace</h1>
            <p className="mt-1 text-sm text-gray-400">
              Start with one organization and clinic. More locations can be added later.
            </p>
          </div>
        </div>

        <div className="grid gap-5 md:grid-cols-2">
          <label className="text-xs font-medium text-gray-400">
            Your name
            <input
              className={`${inputClass} mt-1.5`}
              value={form.ownerName}
              onChange={event => update('ownerName', event.target.value)}
              autoComplete="name"
              minLength={2}
              maxLength={120}
              required
            />
          </label>
          <label className="text-xs font-medium text-gray-400">
            Work email
            <input
              type="email"
              className={`${inputClass} mt-1.5`}
              value={form.email}
              onChange={event => update('email', event.target.value)}
              autoComplete="email"
              required
            />
          </label>
          <label className="text-xs font-medium text-gray-400">
            Password
            <input
              type="password"
              className={`${inputClass} mt-1.5`}
              value={form.password}
              onChange={event => update('password', event.target.value)}
              autoComplete="new-password"
              minLength={12}
              maxLength={200}
              required
            />
            <span className="mt-1 block font-normal text-gray-600">At least 12 characters</span>
          </label>
          <label className="text-xs font-medium text-gray-400">
            Confirm password
            <input
              type="password"
              className={`${inputClass} mt-1.5`}
              value={form.confirmPassword}
              onChange={event => update('confirmPassword', event.target.value)}
              autoComplete="new-password"
              minLength={12}
              required
            />
          </label>
        </div>

        <div className="my-7 border-t border-gray-800" />

        <div className="mb-4 flex items-center gap-2">
          <Stethoscope className="h-4 w-4 text-blue-400" />
          <h2 className="text-sm font-semibold text-white">Organization and first clinic</h2>
        </div>
        <div className="grid gap-5 md:grid-cols-2">
          <label className="text-xs font-medium text-gray-400">
            Organization name
            <input
              className={`${inputClass} mt-1.5`}
              value={form.organizationName}
              onChange={event => update('organizationName', event.target.value)}
              minLength={2}
              maxLength={160}
              required
            />
          </label>
          <label className="text-xs font-medium text-gray-400">
            Clinic name
            <input
              className={`${inputClass} mt-1.5`}
              value={form.clinicName}
              onChange={event => update('clinicName', event.target.value)}
              minLength={2}
              maxLength={160}
              required
            />
          </label>
          <label className="text-xs font-medium text-gray-400">
            Country
            <select
              className={`${inputClass} mt-1.5`}
              value={form.countryCode}
              onChange={event => selectCountry(event.target.value)}
            >
              {countryOptions.map(option => (
                <option key={option.countryCode} value={option.countryCode}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-gray-400">
            Clinic phone
            <input
              type="tel"
              className={`${inputClass} mt-1.5`}
              value={form.clinicPhone}
              onChange={event => update('clinicPhone', event.target.value)}
              placeholder={`+${form.defaultCallingCode} ...`}
              autoComplete="tel"
              minLength={7}
              maxLength={30}
              required
            />
          </label>
          <label className="text-xs font-medium text-gray-400 md:col-span-2">
            Clinic timezone
            <input
              className={`${inputClass} mt-1.5`}
              value={form.timezone}
              onChange={event => update('timezone', event.target.value)}
              placeholder="Asia/Kolkata"
              required
            />
          </label>
        </div>

        <label className="mt-6 flex items-start gap-3 text-sm text-gray-400">
          <input
            type="checkbox"
            checked={form.acceptTerms}
            onChange={event => update('acceptTerms', event.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-gray-600 bg-gray-800 text-blue-600"
            required
          />
          <span>
            I agree to the{' '}
            {termsUrl ? (
              <a href={termsUrl} target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300">
                Terms of Service
              </a>
            ) : 'Terms of Service'}{' '}
            and{' '}
            {privacyUrl ? (
              <a href={privacyUrl} target="_blank" rel="noreferrer" className="text-blue-400 hover:text-blue-300">
                Privacy Policy
              </a>
            ) : 'Privacy Policy'}.
          </span>
        </label>

        {!legalDocumentsConfigured && (
          <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-300">
            Registration requires the Terms and Privacy URLs to be configured by the service operator.
          </div>
        )}

        {error && (
          <div className="mt-5 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2.5 text-sm text-red-400">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting || !legalDocumentsConfigured}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          Create organization
        </button>

        <p className="mt-5 text-center text-xs text-gray-500">
          Already have an account?{' '}
          <Link href="/sign-in" className="text-blue-400 hover:text-blue-300">Sign in</Link>
        </p>
      </form>
    </div>
  );
}
