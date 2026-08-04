'use client';

import { FormEvent, Suspense, useState } from 'react';
import axios from 'axios';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertTriangle, ArrowLeft, Info, Loader2, ShieldCheck, UserPlus } from 'lucide-react';
import AuthShell from '@/components/ui/AuthShell';
import api from '@/lib/api';

interface AcceptInviteResponse {
  success: boolean;
  loginRequired: boolean;
}

function AcceptInviteContent() {
  const token = useSearchParams().get('token') ?? '';
  const router = useRouter();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const response = await api.post<AcceptInviteResponse>('/auth/invites/accept', {
        token,
        name,
        password,
      });
      if (!response.data.success || !response.data.loginRequired) {
        throw new Error('Unexpected invitation response');
      }
      setPassword('');
      router.replace('/sign-in?invite=accepted');
    } catch (err: unknown) {
      const message = axios.isAxiosError(err)
        ? err.response?.data?.error
        : undefined;
      setError(message ?? 'Unable to accept invite');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell>
      <section className="surface-card rounded-[1.45rem] p-6 shadow-[var(--shadow-md)] sm:p-8" aria-labelledby="accept-invite-title">
        <div className="flex items-center justify-between gap-4">
          <span className="flex h-12 w-12 items-center justify-center rounded-[15px] bg-brand-soft text-brand" aria-hidden="true">
            <UserPlus className="h-5 w-5" />
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-subtle px-3 py-1.5 text-[0.64rem] font-bold uppercase tracking-[0.12em] text-muted">
            <ShieldCheck className="h-3.5 w-3.5 text-brand" aria-hidden="true" />
            Secure invitation
          </span>
        </div>

        <p className="mt-6 text-[0.68rem] font-bold uppercase tracking-[0.16em] text-brand">Your clinic team</p>
        <h1 id="accept-invite-title" className="font-display mt-2 text-[2.35rem] leading-[1.04] tracking-[-0.045em] text-ink">
          Join your clinic workspace.
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted">
          New users create their account here. Existing users should enter their current account details.
        </p>

        <form onSubmit={submit} className="mt-7" aria-busy={loading}>
          <div className="space-y-5">
            <div>
              <label htmlFor="invite-full-name" className="ui-label">Full name</label>
              <input
                id="invite-full-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                maxLength={120}
                className="ui-input"
                required
              />
            </div>
            <div>
              <label htmlFor="invite-password" className="ui-label">Account password</label>
              <input
                id="invite-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                minLength={12}
                maxLength={200}
                className="ui-input"
                aria-describedby="invite-password-help"
                required
              />
              <p id="invite-password-help" className="ui-help">
                Use your existing password, or create one with at least 12 characters.
              </p>
            </div>
          </div>

          <div className="mt-5 space-y-3">
            {!token && (
              <div className="alert-warning" role="status">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <p>This invitation link is incomplete. Request a new invite from your organization owner.</p>
              </div>
            )}
            {error && (
              <div className="alert-error" role="alert" aria-live="assertive">
                <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <p>{error}</p>
              </div>
            )}
          </div>

          <button type="submit" disabled={loading || !token} className="btn-primary mt-6 min-h-12 w-full text-sm">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <UserPlus className="h-4 w-4" aria-hidden="true" />}
            Accept invite
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

export default function AcceptInvitePage() {
  return (
    <Suspense fallback={<AcceptInviteFallback />}>
      <AcceptInviteContent />
    </Suspense>
  );
}

function AcceptInviteFallback() {
  return (
    <AuthShell>
      <div className="surface-card flex min-h-64 items-center justify-center rounded-[1.45rem]" aria-busy="true">
        <div className="text-center">
          <Loader2 className="mx-auto h-6 w-6 animate-spin text-brand" aria-hidden="true" />
          <p className="mt-3 text-sm text-muted">Preparing your invitation</p>
        </div>
      </div>
    </AuthShell>
  );
}
