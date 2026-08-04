'use client';

import { FormEvent, Suspense, useState } from 'react';
import axios from 'axios';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { AlertTriangle, ArrowLeft, CheckCircle2, Info, Loader2, LockKeyhole } from 'lucide-react';
import AuthShell from '@/components/ui/AuthShell';
import api from '@/lib/api';

function ResetPasswordContent() {
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      await api.post('/auth/reset-password', { token, password });
      setDone(true);
    } catch (err: unknown) {
      const message = axios.isAxiosError(err)
        ? err.response?.data?.error
        : undefined;
      setError(message ?? 'Unable to reset password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell>
      <section className="surface-card rounded-[1.45rem] p-6 shadow-[var(--shadow-md)] sm:p-8" aria-labelledby="reset-password-title">
        <span className="flex h-12 w-12 items-center justify-center rounded-[15px] bg-brand-soft text-brand" aria-hidden="true">
          <LockKeyhole className="h-5 w-5" />
        </span>
        <p className="mt-6 text-[0.68rem] font-bold uppercase tracking-[0.16em] text-brand">Secure your account</p>
        <h1 id="reset-password-title" className="font-display mt-2 text-[2.35rem] leading-[1.04] tracking-[-0.045em] text-ink">
          Choose a new password.
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted">Make it memorable, unique, and at least 12 characters long.</p>

        <form onSubmit={submit} className="mt-7" aria-busy={loading}>
          <label htmlFor="reset-password" className="ui-label">New password</label>
          <input
            id="reset-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="ui-input"
            autoComplete="new-password"
            minLength={12}
            aria-describedby="reset-password-help"
            required
          />
          <p id="reset-password-help" className="ui-help">Use at least 12 characters.</p>

          <div className="mt-5 space-y-3">
            {!token && (
              <div className="alert-warning" role="status">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <p>This reset link is incomplete. Request a fresh link from the sign-in page.</p>
              </div>
            )}
            {error && (
              <div className="alert-error" role="alert" aria-live="assertive">
                <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <p>{error}</p>
              </div>
            )}
            {done && (
              <div className="alert-success" role="status" aria-live="polite">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <p>Password reset. You can sign in now.</p>
              </div>
            )}
          </div>

          <button type="submit" disabled={loading || !token || done} className="btn-primary mt-6 min-h-12 w-full text-sm">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <LockKeyhole className="h-4 w-4" aria-hidden="true" />}
            Reset password
          </button>

          <Link href="/sign-in" className="mt-5 flex items-center justify-center gap-2 text-xs font-bold text-brand hover:text-brand-dark">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            Back to sign in
          </Link>
        </form>
      </section>
    </AuthShell>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<AuthPageFallback label="Preparing your secure reset" />}>
      <ResetPasswordContent />
    </Suspense>
  );
}

function AuthPageFallback({ label }: { label: string }) {
  return (
    <AuthShell>
      <div className="surface-card flex min-h-64 items-center justify-center rounded-[1.45rem]" aria-busy="true">
        <div className="text-center">
          <Loader2 className="mx-auto h-6 w-6 animate-spin text-brand" aria-hidden="true" />
          <p className="mt-3 text-sm text-muted">{label}</p>
        </div>
      </div>
    </AuthShell>
  );
}
