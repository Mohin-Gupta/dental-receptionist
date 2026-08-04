'use client';

import { FormEvent, useEffect, useState } from 'react';
import axios from 'axios';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Info, KeyRound, Loader2, LockKeyhole, LogIn, ShieldCheck } from 'lucide-react';
import AuthShell from '@/components/ui/AuthShell';
import api, { setCsrfToken } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export default function SignInPage() {
  const router = useRouter();
  const { refresh } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    if (searchParams.get('recovery') === '1') {
      setUseRecoveryCode(true);
      setNotice('Sign in with your password, then enter one of your one-time recovery codes.');
    } else if (searchParams.get('mfa') === 'disabled') {
      setNotice('MFA was disabled and all signed-in sessions were revoked. Sign in again to continue.');
    } else if (searchParams.get('invite') === 'accepted') {
      setNotice('Invitation accepted. Sign in to continue; multi-factor authentication may be required.');
    }
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError('');

    try {
      const response = await api.post('/auth/login', {
        email,
        password,
        totpCode: mfaRequired && !useRecoveryCode ? totpCode : undefined,
        recoveryCode: mfaRequired && useRecoveryCode ? recoveryCode : undefined,
      });

      if (response.status === 202 || response.data?.mfaRequired) {
        setMfaRequired(true);
        return;
      }

      setCsrfToken(response.data.csrfToken);
      const redirectedToMfa = await refresh();
      if (!redirectedToMfa) {
        router.replace(response.data?.recoveryCodeUsed === true ? '/mfa' : '/dashboard');
      }
    } catch (err: unknown) {
      const message = axios.isAxiosError(err)
        ? err.response?.data?.error
        : undefined;
      setError(message ?? 'Unable to sign in');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell>
      <section className="surface-card overflow-hidden rounded-[1.45rem] shadow-[var(--shadow-md)]" aria-labelledby="sign-in-title">
        <div className="p-6 sm:p-8">
          <div className="flex items-center justify-between gap-4">
            <span className="inline-flex h-11 w-11 items-center justify-center rounded-[14px] bg-brand-soft text-brand" aria-hidden="true">
              {mfaRequired ? <KeyRound className="h-5 w-5" /> : <ShieldCheck className="h-5 w-5" />}
            </span>
            <span className="rounded-full border border-line bg-surface-subtle px-3 py-1.5 text-[0.64rem] font-bold uppercase tracking-[0.14em] text-muted">
              Secure clinic access
            </span>
          </div>

          <div className="mt-6">
            <p className="text-[0.68rem] font-bold uppercase tracking-[0.16em] text-brand">
              {mfaRequired ? 'One final check' : 'Welcome back'}
            </p>
            <h1 id="sign-in-title" className="font-display mt-2 text-[2.25rem] leading-[1.04] tracking-[-0.045em] text-ink sm:text-[2.55rem]">
              {mfaRequired ? 'Verify it’s really you.' : 'Your front desk is ready.'}
            </h1>
            <p className="mt-3 text-sm leading-6 text-muted">
              {mfaRequired
                ? 'Keep your account protected with the second step from your authenticator.'
                : 'Sign in to manage patient calls, appointments, and your clinic team.'}
            </p>
          </div>

          {notice && (
            <div className="alert-info mt-5" role="status">
              <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <p>{notice}</p>
            </div>
          )}

          <form onSubmit={submit} className="mt-7" aria-busy={loading}>
            <div className="space-y-5">
              <div>
                <label htmlFor="sign-in-email" className="ui-label">Work email</label>
                <input
                  id="sign-in-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="ui-input"
                  autoComplete="email"
                  required
                />
              </div>

              <div>
                <div className="flex items-center justify-between gap-3">
                  <label htmlFor="sign-in-password" className="ui-label">Password</label>
                  <Link href="/forgot-password" className="mb-1.5 text-xs font-semibold text-brand hover:text-brand-dark">
                    Forgot password?
                  </Link>
                </div>
                <input
                  id="sign-in-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="ui-input"
                  autoComplete="current-password"
                  required
                />
              </div>

              {mfaRequired && (
                <div className="rounded-2xl border border-line bg-brand-softer p-4 sm:p-5">
                  <div className="mb-4 flex items-center gap-2 text-xs font-semibold text-ink-soft">
                    <LockKeyhole className="h-4 w-4 text-brand" aria-hidden="true" />
                    Multi-factor verification
                  </div>
                  <label htmlFor="sign-in-mfa-code" className="ui-label">
                    {useRecoveryCode ? 'Recovery code' : 'Authenticator code'}
                  </label>
                  <input
                    id="sign-in-mfa-code"
                    type="text"
                    inputMode={useRecoveryCode ? 'text' : 'numeric'}
                    value={useRecoveryCode ? recoveryCode : totpCode}
                    onChange={(e) => useRecoveryCode
                      ? setRecoveryCode(e.target.value)
                      : setTotpCode(e.target.value)}
                    className="ui-input font-mono tracking-[0.16em]"
                    autoComplete={useRecoveryCode ? 'off' : 'one-time-code'}
                    required={mfaRequired}
                  />
                  <button
                    type="button"
                    onClick={() => setUseRecoveryCode((value) => !value)}
                    className="mt-3 text-xs font-semibold text-brand hover:text-brand-dark"
                  >
                    {useRecoveryCode ? 'Use authenticator code instead' : 'Use a recovery code instead'}
                  </button>
                </div>
              )}
            </div>

            {error && (
              <div className="alert-error mt-5" role="alert" aria-live="assertive">
                <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <p>{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="btn-primary mt-6 min-h-12 w-full text-sm"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <LogIn className="h-4 w-4" aria-hidden="true" />}
              Sign in
            </button>
          </form>
        </div>

        <div className="border-t border-line bg-surface-subtle px-6 py-5 text-center sm:px-8">
          <p className="text-xs leading-5 text-muted">Setting up a new clinic organization?</p>
          <Link href="/register" className="mt-1.5 inline-flex text-sm font-bold text-brand hover:text-brand-dark">
            Create your clinic workspace
          </Link>
        </div>
      </section>
    </AuthShell>
  );
}
