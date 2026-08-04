'use client';

import axios from 'axios';
import Link from 'next/link';
import { FormEvent, useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Building2,
  CheckCircle2,
  Info,
  Loader2,
  Mail,
  MapPin,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import AuthShell from '@/components/ui/AuthShell';
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

const inputClass = 'ui-input';

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

  const update = (key: keyof typeof form, value: string) => {
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
      const response = await api.post<{ success: boolean; verificationDeliveryPending?: boolean }>(
        '/auth/resend-verification',
        { email: form.email },
        { headers: { 'Idempotency-Key': createIdempotencyKey('verification-resend') } }
      );
      setNotice(
        response.data.verificationDeliveryPending
          ? 'We could not deliver the email right now. Please try again shortly.'
          : 'A new verification email has been sent.'
      );
    } catch (requestError) {
      setError(errorMessage(requestError, 'Unable to resend the verification email'));
    } finally {
      setResending(false);
    }
  };

  if (registered) {
    return (
      <AuthShell>
        <section className="surface-card rounded-[1.45rem] p-6 text-center shadow-[var(--shadow-md)] sm:p-8" aria-labelledby="registration-complete-title">
          <div
            className={`mx-auto flex h-14 w-14 items-center justify-center rounded-[18px] ${
              registered.verificationDeliveryPending
                ? 'bg-warning-soft text-warning'
                : 'bg-success-soft text-success'
            }`}
            aria-hidden="true"
          >
            {registered.verificationDeliveryPending ? <Mail className="h-6 w-6" /> : <CheckCircle2 className="h-6 w-6" />}
          </div>
          <p className="mt-6 text-[0.68rem] font-bold uppercase tracking-[0.16em] text-brand">Workspace created</p>
          <h1 id="registration-complete-title" className="font-display mt-2 text-[2.35rem] leading-[1.04] tracking-[-0.045em] text-ink">
            One quick step to begin.
          </h1>
          <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted">
            {registered.verificationDeliveryPending
              ? 'Your workspace is ready, but the first verification email could not be delivered. Retry below.'
              : `We sent a verification link to ${form.email}. Verify your address before signing in.`}
          </p>

          <div className="mt-6 space-y-3 text-left" aria-live="polite">
            {notice && (
              <div className="alert-info" role="status">
                <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <p>{notice}</p>
              </div>
            )}
            {error && (
              <div className="alert-error" role="alert">
                <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <p>{error}</p>
              </div>
            )}
          </div>

          <div className="mt-7 grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={resendVerification}
              disabled={resending}
              className="btn-secondary min-h-12"
            >
              {resending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Resend verification
            </button>
            <Link href="/sign-in" className="btn-primary min-h-12">
              Go to sign in
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
        </section>
      </AuthShell>
    );
  }

  return (
    <AuthShell wide>
      <section className="surface-card overflow-hidden rounded-[1.45rem] shadow-[var(--shadow-md)]" aria-labelledby="register-title">
        <div className="border-b border-line bg-surface-subtle px-6 py-6 sm:px-8">
          <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-start">
            <div>
              <p className="text-[0.68rem] font-bold uppercase tracking-[0.16em] text-brand">New clinic workspace</p>
              <h1 id="register-title" className="font-display mt-2 text-[2.2rem] leading-[1.04] tracking-[-0.045em] text-ink sm:text-[2.55rem]">
                Build your calmer front desk.
              </h1>
              <p className="mt-3 max-w-xl text-sm leading-6 text-muted">
                Start with one organization and clinic. More locations can be added later.
              </p>
            </div>
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[15px] bg-brand-soft text-brand" aria-hidden="true">
              <Building2 className="h-5 w-5" />
            </span>
          </div>
        </div>

        <form onSubmit={submit} className="p-6 sm:p-8" aria-busy={submitting}>
          <section aria-labelledby="account-details-title">
            <div className="mb-5 flex items-center gap-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-brand text-xs font-bold text-white">01</span>
              <div>
                <h2 id="account-details-title" className="text-sm font-bold text-ink">Your account</h2>
                <p className="mt-0.5 text-xs text-muted">The workspace owner and secure sign-in details.</p>
              </div>
            </div>

            <div className="grid gap-5 md:grid-cols-2">
              <div>
                <label htmlFor="register-owner-name" className="ui-label">Your name</label>
                <div className="relative">
                  <UserRound className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
                  <input
                    id="register-owner-name"
                    className={`${inputClass} pl-10`}
                    value={form.ownerName}
                    onChange={event => update('ownerName', event.target.value)}
                    autoComplete="name"
                    minLength={2}
                    maxLength={120}
                    required
                  />
                </div>
              </div>
              <div>
                <label htmlFor="register-email" className="ui-label">Work email</label>
                <input
                  id="register-email"
                  type="email"
                  className={inputClass}
                  value={form.email}
                  onChange={event => update('email', event.target.value)}
                  autoComplete="email"
                  required
                />
              </div>
              <div>
                <label htmlFor="register-password" className="ui-label">Password</label>
                <input
                  id="register-password"
                  type="password"
                  className={inputClass}
                  value={form.password}
                  onChange={event => update('password', event.target.value)}
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={200}
                  aria-describedby="register-password-help"
                  required
                />
                <p id="register-password-help" className="ui-help">Use at least 12 characters.</p>
              </div>
              <div>
                <label htmlFor="register-confirm-password" className="ui-label">Confirm password</label>
                <input
                  id="register-confirm-password"
                  type="password"
                  className={inputClass}
                  value={form.confirmPassword}
                  onChange={event => update('confirmPassword', event.target.value)}
                  autoComplete="new-password"
                  minLength={12}
                  required
                />
              </div>
            </div>
          </section>

          <div className="my-8 h-px bg-line" />

          <section aria-labelledby="clinic-details-title">
            <div className="mb-5 flex items-center gap-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-brand text-xs font-bold text-white">02</span>
              <div>
                <h2 id="clinic-details-title" className="text-sm font-bold text-ink">Clinic profile</h2>
                <p className="mt-0.5 text-xs text-muted">The home base Comeigo will use for patient conversations.</p>
              </div>
            </div>

            <div className="grid gap-5 md:grid-cols-2">
              <div>
                <label htmlFor="register-organization" className="ui-label">Organization name</label>
                <input
                  id="register-organization"
                  className={inputClass}
                  value={form.organizationName}
                  onChange={event => update('organizationName', event.target.value)}
                  minLength={2}
                  maxLength={160}
                  required
                />
              </div>
              <div>
                <label htmlFor="register-clinic" className="ui-label">Clinic name</label>
                <input
                  id="register-clinic"
                  className={inputClass}
                  value={form.clinicName}
                  onChange={event => update('clinicName', event.target.value)}
                  minLength={2}
                  maxLength={160}
                  required
                />
              </div>
              <div>
                <label htmlFor="register-country" className="ui-label">Country</label>
                <select
                  id="register-country"
                  className="ui-select"
                  value={form.countryCode}
                  onChange={event => selectCountry(event.target.value)}
                >
                  {countryOptions.map(option => (
                    <option key={option.countryCode} value={option.countryCode}>{option.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="register-phone" className="ui-label">Clinic phone</label>
                <input
                  id="register-phone"
                  type="tel"
                  className={inputClass}
                  value={form.clinicPhone}
                  onChange={event => update('clinicPhone', event.target.value)}
                  placeholder={`+${form.defaultCallingCode} ...`}
                  autoComplete="tel"
                  minLength={7}
                  maxLength={30}
                  required
                />
              </div>
              <div className="md:col-span-2">
                <label htmlFor="register-timezone" className="ui-label">Clinic timezone</label>
                <div className="relative">
                  <MapPin className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
                  <input
                    id="register-timezone"
                    className={`${inputClass} pl-10`}
                    value={form.timezone}
                    onChange={event => update('timezone', event.target.value)}
                    placeholder="Asia/Kolkata"
                    required
                  />
                </div>
              </div>
            </div>
          </section>

          {error && (
            <div className="alert-error mt-6" role="alert" aria-live="assertive">
              <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <p>{error}</p>
            </div>
          )}

          <button type="submit" disabled={submitting} className="btn-primary mt-7 min-h-12 w-full text-sm">
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ShieldCheck className="h-4 w-4" aria-hidden="true" />}
            Create organization
          </button>

          <p className="mt-6 text-center text-xs text-muted">
            Already have an account?{' '}
            <Link href="/sign-in" className="font-bold text-brand hover:text-brand-dark">Sign in</Link>
          </p>
        </form>
      </section>
    </AuthShell>
  );
}
