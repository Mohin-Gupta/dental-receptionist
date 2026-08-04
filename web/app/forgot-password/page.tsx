'use client';

import { FormEvent, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, CheckCircle2, Loader2, Mail } from 'lucide-react';
import AuthShell from '@/components/ui/AuthShell';
import api from '@/lib/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    try {
      await api.post('/auth/forgot-password', { email });
      setSent(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell>
      <section className="surface-card rounded-[1.45rem] p-6 shadow-[var(--shadow-md)] sm:p-8" aria-labelledby="forgot-password-title">
        <span className="flex h-12 w-12 items-center justify-center rounded-[15px] bg-brand-soft text-brand" aria-hidden="true">
          <Mail className="h-5 w-5" />
        </span>
        <p className="mt-6 text-[0.68rem] font-bold uppercase tracking-[0.16em] text-brand">Account recovery</p>
        <h1 id="forgot-password-title" className="font-display mt-2 text-[2.35rem] leading-[1.04] tracking-[-0.045em] text-ink">
          Reset your password.
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted">
          Enter your email and we will send reset instructions if the account exists.
        </p>

        <form onSubmit={submit} className="mt-7" aria-busy={loading}>
          <label htmlFor="forgot-password-email" className="ui-label">Work email</label>
          <input
            id="forgot-password-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="ui-input"
            autoComplete="email"
            required
          />

          {sent && (
            <div className="alert-success mt-5" role="status" aria-live="polite">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <p>Check your email for a reset link.</p>
            </div>
          )}

          <button type="submit" disabled={loading} className="btn-primary mt-6 min-h-12 w-full text-sm">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Mail className="h-4 w-4" aria-hidden="true" />}
            Send reset link
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
