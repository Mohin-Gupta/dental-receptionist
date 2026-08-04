'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowRight, CheckCircle, Loader2, MailCheck, XCircle } from 'lucide-react';
import AuthShell from '@/components/ui/AuthShell';
import api from '@/lib/api';

function VerifyEmailContent() {
  const token = useSearchParams().get('token') ?? '';
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');

  useEffect(() => {
    if (!token) {
      setStatus('error');
      return;
    }

    api
      .post('/auth/verify-email', { token })
      .then(() => setStatus('success'))
      .catch(() => setStatus('error'));
  }, [token]);

  return (
    <AuthShell>
      <section className="surface-card rounded-[1.45rem] p-6 text-center shadow-[var(--shadow-md)] sm:p-8" aria-labelledby="verify-email-title">
        <div
          className={`mx-auto flex h-14 w-14 items-center justify-center rounded-[18px] ${
            status === 'success'
              ? 'bg-success-soft text-success'
              : status === 'error'
                ? 'bg-danger-soft text-danger'
                : 'bg-brand-soft text-brand'
          }`}
          aria-hidden="true"
        >
          {status === 'loading' && <Loader2 className="h-6 w-6 animate-spin" />}
          {status === 'success' && <CheckCircle className="h-6 w-6" />}
          {status === 'error' && <XCircle className="h-6 w-6" />}
        </div>

        <p className="mt-6 text-[0.68rem] font-bold uppercase tracking-[0.16em] text-brand">Email verification</p>
        <div aria-live="polite" aria-atomic="true">
          <h1 id="verify-email-title" className="font-display mt-2 text-[2.35rem] leading-[1.04] tracking-[-0.045em] text-ink">
            {status === 'success' ? 'Email verified.' : status === 'error' ? 'Verification failed.' : 'Verifying your email…'}
          </h1>
          <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-muted">
            {status === 'success'
              ? 'Your clinic workspace is ready for secure access.'
              : status === 'error'
                ? 'This link may be incomplete, expired, or already used. You can return to sign in for the next step.'
                : 'Please keep this page open while we confirm your address.'}
          </p>
        </div>

        <div className="mx-auto mt-6 flex max-w-sm items-center gap-3 rounded-2xl border border-line bg-surface-subtle p-4 text-left">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-brand shadow-sm" aria-hidden="true">
            <MailCheck className="h-4 w-4" />
          </span>
          <p className="text-xs leading-5 text-muted">Verified addresses help protect clinic and patient information.</p>
        </div>

        <Link href="/sign-in" className="btn-primary mt-7 min-h-12 w-full text-sm">
          Back to sign in
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </section>
    </AuthShell>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<VerifyEmailFallback />}>
      <VerifyEmailContent />
    </Suspense>
  );
}

function VerifyEmailFallback() {
  return (
    <AuthShell>
      <div className="surface-card flex min-h-64 items-center justify-center rounded-[1.45rem]" aria-busy="true">
        <div className="text-center">
          <Loader2 className="mx-auto h-6 w-6 animate-spin text-brand" aria-hidden="true" />
          <p className="mt-3 text-sm text-muted">Preparing verification</p>
        </div>
      </div>
    </AuthShell>
  );
}
