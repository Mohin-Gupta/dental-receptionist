'use client';

import { type FormEvent, useEffect, useState } from 'react';
import axios from 'axios';
import Image from 'next/image';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clipboard,
  Download,
  Info,
  KeyRound,
  Loader2,
  LockKeyhole,
  LogOut,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import AuthShell from '@/components/ui/AuthShell';
import api from '@/lib/api';
import { useAuth } from '@/lib/auth';

interface MfaStatus {
  required: boolean;
  enabled: boolean;
  sessionVerified: boolean;
  sessionVerificationMethod: 'totp' | 'recovery_code' | null;
  replacementRecommended: boolean;
  recoveryCodesRemaining: number;
  pendingSetup?: boolean;
}

type MfaFlow =
  | 'overview'
  | 'verify-session'
  | 'enroll'
  | 'replace'
  | 'regenerate'
  | 'disable'
  | 'recovery-codes';

type RecoveryCodeReason = 'enrollment' | 'replacement' | 'regeneration';

function apiErrorMessage(error: unknown, fallback: string): string {
  if (!axios.isAxiosError(error)) return fallback;
  const message = error.response?.data?.error;
  return typeof message === 'string' && message.trim() ? message : fallback;
}

function apiErrorCode(error: unknown): string | null {
  if (!axios.isAxiosError(error)) return null;
  const code = error.response?.data?.code;
  return typeof code === 'string' ? code : null;
}

function recoveryCodeCountLabel(count: number): string {
  return `${count} recovery ${count === 1 ? 'code' : 'codes'} remaining`;
}

export default function MfaPage() {
  const { user, loading } = useAuth();
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [flow, setFlow] = useState<MfaFlow>('overview');
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState('');
  const [manualEntryKey, setManualEntryKey] = useState('');
  const [manualKeyCopied, setManualKeyCopied] = useState(false);
  const [setupId, setSetupId] = useState('');
  const [pendingExpiresAt, setPendingExpiresAt] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [recoveryCodeReason, setRecoveryCodeReason] = useState<RecoveryCodeReason>('enrollment');
  const [recoveryCodesAcknowledged, setRecoveryCodesAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  useEffect(() => {
    if (!user) return;

    let active = true;
    setError('');
    api.get<MfaStatus>('/auth/mfa/status')
      .then((response) => {
        if (!active) return;
        setStatus(response.data);
        if (!response.data.enabled && response.data.required) setFlow('enroll');
        else if (response.data.enabled && !response.data.sessionVerified) setFlow('verify-session');
        else setFlow('overview');
      })
      .catch(() => {
        if (active) setError('Unable to load your MFA status. Please try again.');
      });

    return () => {
      active = false;
    };
  }, [user]);

  const resetSensitiveFields = () => {
    setPassword('');
    setCode('');
    setQrCodeDataUrl('');
    setManualEntryKey('');
    setManualKeyCopied(false);
    setSetupId('');
    setPendingExpiresAt('');
    setConfirmDisable(false);
  };

  const openFlow = (nextFlow: MfaFlow) => {
    resetSensitiveFields();
    setError('');
    setNotice('');
    setFlow(nextFlow);
  };

  const startSetup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (flow !== 'enroll' && flow !== 'replace') return;

    const intent = flow === 'replace' ? 'replace' : 'enroll';
    setBusy('setup');
    setError('');
    setNotice('');
    try {
      const response = await api.post<{
        setupId: string;
        qrCodeDataUrl: string;
        manualEntryKey: string;
        pendingExpiresAt: string;
      }>('/auth/mfa/setup', { password, intent });
      setQrCodeDataUrl(response.data.qrCodeDataUrl);
      setManualEntryKey(response.data.manualEntryKey);
      setManualKeyCopied(false);
      setSetupId(response.data.setupId);
      setPendingExpiresAt(response.data.pendingExpiresAt);
      setPassword('');
      setCode('');
    } catch (err: unknown) {
      if (apiErrorCode(err) === 'mfa_reauthentication_required') {
        resetSensitiveFields();
        setFlow('verify-session');
      }
      setError(apiErrorMessage(err, 'Unable to start authenticator setup.'));
    } finally {
      setBusy(null);
    }
  };

  const verify = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy('verify');
    setError('');
    setNotice('');
    try {
      const response = await api.post<{ success: boolean; recoveryCodes?: string[] }>(
        '/auth/mfa/verify',
        setupId ? { code, setupId } : { code }
      );
      const generatedCodes = response.data.recoveryCodes ?? [];
      const wasSetup = flow === 'enroll' || flow === 'replace';

      setStatus((current) => current
        ? {
            ...current,
            enabled: true,
            sessionVerified: true,
            sessionVerificationMethod: 'totp',
            replacementRecommended: false,
            recoveryCodesRemaining: generatedCodes.length || current.recoveryCodesRemaining,
            pendingSetup: false,
          }
        : current);
      setCode('');
      setQrCodeDataUrl('');
      setManualEntryKey('');
      setManualKeyCopied(false);
      setSetupId('');
      setPendingExpiresAt('');

      if (wasSetup && generatedCodes.length > 0) {
        setRecoveryCodes(generatedCodes);
        setRecoveryCodeReason(flow === 'replace' ? 'replacement' : 'enrollment');
        setRecoveryCodesAcknowledged(false);
        setCopied(false);
        setFlow('recovery-codes');
      } else {
        setFlow('overview');
        setNotice(wasSetup
          ? 'Your authenticator is now active.'
          : 'This session is now MFA-verified.');
      }
    } catch (err: unknown) {
      const terminalSetupErrors = new Set([
        'mfa_enrollment_expired',
        'mfa_enrollment_exhausted',
        'mfa_enrollment_not_found',
      ]);
      if (terminalSetupErrors.has(apiErrorCode(err) ?? '')) {
        setQrCodeDataUrl('');
        setManualEntryKey('');
        setManualKeyCopied(false);
        setSetupId('');
        setPendingExpiresAt('');
        setCode('');
        setStatus((current) => current ? { ...current, pendingSetup: false } : current);
      }
      setError(apiErrorMessage(err, 'Unable to verify the authenticator code.'));
    } finally {
      setBusy(null);
    }
  };

  const regenerateRecoveryCodes = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy('regenerate');
    setError('');
    setNotice('');
    try {
      const response = await api.post<{ recoveryCodes: string[] }>(
        '/auth/mfa/recovery-codes/regenerate',
        { password, code }
      );
      setPassword('');
      setCode('');
      setRecoveryCodes(response.data.recoveryCodes);
      setRecoveryCodeReason('regeneration');
      setRecoveryCodesAcknowledged(false);
      setCopied(false);
      setStatus((current) => current
        ? { ...current, recoveryCodesRemaining: response.data.recoveryCodes.length }
        : current);
      setFlow('recovery-codes');
    } catch (err: unknown) {
      setError(apiErrorMessage(err, 'Unable to generate new recovery codes.'));
    } finally {
      setBusy(null);
    }
  };

  const disableMfa = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!confirmDisable || status?.required) return;

    setBusy('disable');
    setError('');
    setNotice('');
    try {
      await api.post<{ success: boolean }>('/auth/mfa/disable', { password, code });
      window.location.assign('/sign-in?mfa=disabled');
    } catch (err: unknown) {
      setError(apiErrorMessage(err, 'Unable to disable MFA.'));
    } finally {
      setBusy(null);
    }
  };

  const revokeOtherSessions = async () => {
    setBusy('revoke');
    setError('');
    setNotice('');
    try {
      await api.post<{ success: boolean }>('/auth/logout-all-except-current');
      setConfirmRevoke(false);
      setNotice('All other sessions have been signed out. This session remains active.');
    } catch (err: unknown) {
      if (apiErrorCode(err) === 'mfa_reauthentication_required') {
        setConfirmRevoke(false);
        setFlow('verify-session');
      }
      setError(apiErrorMessage(err, 'Unable to sign out other sessions.'));
    } finally {
      setBusy(null);
    }
  };

  const signInWithRecoveryCode = async () => {
    setBusy('recovery-sign-in');
    setError('');
    try {
      await api.post('/auth/logout');
      window.location.assign('/sign-in?recovery=1');
    } catch (err: unknown) {
      setError(apiErrorMessage(err, 'Unable to restart sign-in. Please sign out and try again.'));
      setBusy(null);
    }
  };

  const cancelSetup = async () => {
    if (!setupId) {
      openFlow('overview');
      return;
    }
    setBusy('cancel-setup');
    setError('');
    try {
      await api.post('/auth/mfa/setup/cancel', { setupId });
      setStatus((current) => current ? { ...current, pendingSetup: false } : current);
      openFlow('overview');
      setNotice('The pending authenticator setup was cancelled. Your current authenticator is unchanged.');
    } catch (err: unknown) {
      setError(apiErrorMessage(err, 'Unable to cancel the pending authenticator setup.'));
    } finally {
      setBusy(null);
    }
  };

  const copyRecoveryCodes = async () => {
    setError('');
    try {
      await navigator.clipboard.writeText(recoveryCodes.join('\n'));
      setCopied(true);
    } catch {
      setError('Copying was blocked by your browser. Download the codes or copy them manually.');
    }
  };

  const copyManualEntryKey = async () => {
    setError('');
    try {
      await navigator.clipboard.writeText(manualEntryKey);
      setManualKeyCopied(true);
    } catch {
      setError('Copying was blocked by your browser. Select and copy the setup key manually.');
    }
  };

  const downloadRecoveryCodes = () => {
    const contents = [
      'Maya MFA recovery codes',
      `Generated: ${new Date().toISOString()}`,
      '',
      ...recoveryCodes,
      '',
      'Each code can be used once. Store these codes somewhere separate from your authenticator device.',
    ].join('\n');
    const objectUrl = URL.createObjectURL(new Blob([contents], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = 'maya-recovery-codes.txt';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
  };

  const finishRecoveryCodes = () => {
    if (!recoveryCodesAcknowledged) return;
    const wasReplacement = recoveryCodeReason === 'replacement';
    setRecoveryCodes([]);
    setRecoveryCodesAcknowledged(false);
    setCopied(false);
    setFlow('overview');
    setNotice(wasReplacement
      ? 'Your new authenticator is active. For a lost device, sign out other sessions as a final precaution.'
      : 'Your recovery codes are ready for emergency use.');
  };

  if (loading) {
    return (
      <AuthShell>
        <section className="surface-card flex min-h-64 items-center justify-center rounded-[1.45rem]" aria-busy="true">
          <div className="text-center">
            <Loader2 className="mx-auto h-7 w-7 animate-spin text-brand" aria-hidden="true" />
            <p className="mt-3 text-sm text-muted">Loading account security</p>
          </div>
        </section>
      </AuthShell>
    );
  }

  if (!user) {
    return (
      <AuthShell>
        <section className="surface-card rounded-[1.45rem] p-6 text-center shadow-[var(--shadow-md)] sm:p-8" aria-labelledby="mfa-sign-in-title">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-[18px] bg-brand-soft text-brand" aria-hidden="true">
            <ShieldCheck className="h-6 w-6" />
          </span>
          <p className="mt-6 text-[0.68rem] font-bold uppercase tracking-[0.16em] text-brand">Account security</p>
          <h1 id="mfa-sign-in-title" className="font-display mt-2 text-[2.3rem] leading-[1.04] tracking-[-0.045em] text-ink">Sign in to manage MFA.</h1>
          <p className="mt-3 text-sm leading-6 text-muted">Your security settings are available after you sign in.</p>
          <Link href="/sign-in" className="btn-primary mt-7 min-h-12 w-full text-sm">
            Go to sign in
          </Link>
        </section>
      </AuthShell>
    );
  }

  if (!status) {
    if (!error) {
      return (
        <AuthShell>
          <section className="surface-card flex min-h-64 items-center justify-center rounded-[1.45rem]" aria-busy="true">
            <div className="text-center">
              <Loader2 className="mx-auto h-7 w-7 animate-spin text-brand" aria-hidden="true" />
              <p className="mt-3 text-sm text-muted">Loading security settings</p>
            </div>
          </section>
        </AuthShell>
      );
    }

    return (
      <AuthShell>
        <section className="surface-card rounded-[1.45rem] p-6 shadow-[var(--shadow-md)] sm:p-8" aria-labelledby="mfa-load-error-title">
          <span className="flex h-12 w-12 items-center justify-center rounded-[15px] bg-danger-soft text-danger" aria-hidden="true">
            <ShieldAlert className="h-5 w-5" />
          </span>
          <p className="mt-6 text-[0.68rem] font-bold uppercase tracking-[0.16em] text-danger">Security settings</p>
          <h1 id="mfa-load-error-title" className="font-display mt-2 text-[2.3rem] leading-[1.04] tracking-[-0.045em] text-ink">Unable to load security settings.</h1>
          <div className="alert-error mt-5" role="alert">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p>{error}</p>
          </div>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="btn-primary mt-6 min-h-12 w-full text-sm"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Try again
          </button>
        </section>
      </AuthShell>
    );
  }

  const recoveryLogin = status.sessionVerificationMethod === 'recovery_code';
  const legacyVerifiedSession = status.sessionVerified && status.sessionVerificationMethod === null;
  const lowOnRecoveryCodes = status.enabled && status.recoveryCodesRemaining <= 3;

  return (
    <AuthShell wide>
      <div className="mx-auto w-full max-w-3xl">
        <header className="mb-7 flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
          <div>
            <p className="text-[0.68rem] font-bold uppercase tracking-[0.16em] text-brand">Account security</p>
            <h1 className="font-display mt-2 text-[2.45rem] leading-[1.02] tracking-[-0.045em] text-ink sm:text-[2.8rem]">Multi-factor authentication.</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">
              Protect <span className="font-semibold text-ink-soft">{user.email}</span> with an authenticator app and one-time recovery codes.
            </p>
          </div>
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[15px] bg-brand-soft text-brand" aria-hidden="true">
            <ShieldCheck className="h-5 w-5" />
          </span>
        </header>

        <div className="mb-5 space-y-3" aria-live="polite" aria-atomic="true">
          {error && (
            <div className="alert-error" role="alert">
              <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <p>{error}</p>
            </div>
          )}
          {notice && (
            <div className="alert-success" role="status">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <p>{notice}</p>
            </div>
          )}
        </div>

        {flow === 'overview' && (
          <div className="space-y-4">
            {(status.replacementRecommended || recoveryLogin) && (
              <section className="rounded-[1.15rem] border border-[#f0ddb8] bg-warning-soft p-5 shadow-[var(--shadow-sm)]">
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/75 text-warning" aria-hidden="true">
                    <AlertTriangle className="h-4 w-4" />
                  </span>
                  <div>
                    <h2 className="text-sm font-bold text-ink">
                      {legacyVerifiedSession
                        ? 'Authenticator recovery recommended'
                        : 'You signed in with a recovery code'}
                    </h2>
                    <p className="mt-1 text-sm leading-6 text-[#76501a]">
                      {legacyVerifiedSession
                        ? 'This session was created before MFA verification methods were tracked. If your authenticator was lost or compromised, replace it now.'
                        : 'One recovery code has been permanently consumed. If your authenticator was lost or compromised, replace it now so you can use normal six-digit codes again.'}
                    </p>
                    <button
                      type="button"
                      onClick={() => openFlow('replace')}
                      className="btn-secondary mt-4 border-[#d9bd86] bg-white/80"
                    >
                      Replace authenticator now
                    </button>
                  </div>
                </div>
              </section>
            )}

            <section className="surface-card rounded-[1.15rem] p-5 sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-[0.64rem] font-bold uppercase tracking-[0.14em] text-brand">Protection</p>
                  <h2 className="mt-1.5 text-base font-bold text-ink">Security status</h2>
                  <p className="mt-1 text-sm text-muted">
                    {status.enabled ? 'An authenticator app is connected.' : 'No authenticator app is connected.'}
                  </p>
                </div>
                <span className={`status-pill ${
                  status.enabled
                    ? 'status-success'
                    : 'status-neutral'
                }`}>
                  <span className="status-dot" aria-hidden="true" />
                  {status.enabled ? 'MFA enabled' : 'MFA disabled'}
                </span>
              </div>

              {status.enabled && (
                <dl className="mt-5 grid gap-3 border-t border-line pt-5 sm:grid-cols-2">
                  <div className="rounded-xl bg-surface-subtle p-3.5">
                    <dt className="text-[0.62rem] font-bold uppercase tracking-[0.12em] text-muted">Current session</dt>
                    <dd className="mt-1.5 text-sm font-semibold text-ink-soft">
                      {status.sessionVerified
                        ? legacyVerifiedSession
                          ? 'Verified by a legacy MFA session'
                          : `Verified by ${recoveryLogin ? 'recovery code' : 'authenticator'}`
                        : 'Verification required'}
                    </dd>
                  </div>
                  <div className="rounded-xl bg-surface-subtle p-3.5">
                    <dt className="text-[0.62rem] font-bold uppercase tracking-[0.12em] text-muted">Emergency access</dt>
                    <dd className={`mt-1.5 text-sm font-semibold ${lowOnRecoveryCodes ? 'text-warning' : 'text-ink-soft'}`}>
                      {recoveryCodeCountLabel(status.recoveryCodesRemaining)}
                    </dd>
                  </div>
                </dl>
              )}

              {status.pendingSetup && (
                <div className="alert-info mt-4">
                  <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <p>
                    An authenticator setup is waiting for verification. Your active authenticator has not been changed.
                    Start the setup again in this browser if you no longer have its QR code.
                  </p>
                </div>
              )}

              {!status.enabled && (
                <button
                  type="button"
                  onClick={() => openFlow('enroll')}
                  className="btn-primary mt-5"
                >
                  <Smartphone className="h-4 w-4" aria-hidden="true" />
                  Set up authenticator
                </button>
              )}
            </section>

            {status.enabled && (
              <section className="surface-card rounded-[1.15rem] p-5 sm:p-6">
                <p className="text-[0.64rem] font-bold uppercase tracking-[0.14em] text-brand">Security tools</p>
                <h2 className="mt-1.5 text-base font-bold text-ink">Manage MFA</h2>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => openFlow('replace')}
                    className="group rounded-2xl border border-line bg-surface-subtle p-4 text-left transition hover:-translate-y-0.5 hover:border-line-strong hover:bg-white hover:shadow-[var(--shadow-sm)]"
                  >
                    <span className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl bg-brand-soft text-brand" aria-hidden="true">
                      <RefreshCw className="h-4 w-4" />
                    </span>
                    <span className="block text-sm font-bold text-ink">Replace authenticator</span>
                    <span className="mt-1 block text-xs leading-5 text-muted">Connect a new phone without disabling the current method first.</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => openFlow('regenerate')}
                    className="group rounded-2xl border border-line bg-surface-subtle p-4 text-left transition hover:-translate-y-0.5 hover:border-line-strong hover:bg-white hover:shadow-[var(--shadow-sm)]"
                  >
                    <span className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl bg-brand-soft text-brand" aria-hidden="true">
                      <KeyRound className="h-4 w-4" />
                    </span>
                    <span className="block text-sm font-bold text-ink">Generate new recovery codes</span>
                    <span className="mt-1 block text-xs leading-5 text-muted">Immediately invalidate every unused old recovery code.</span>
                  </button>
                </div>

                {lowOnRecoveryCodes && (
                  <div className="alert-warning mt-4">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <p>You are low on recovery codes. Generate a new set before you need emergency access.</p>
                  </div>
                )}
              </section>
            )}

            {status.enabled && (
            <section className="surface-card rounded-[1.15rem] p-5 sm:p-6">
              <div className="flex items-start gap-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[13px] bg-surface-subtle text-muted" aria-hidden="true">
                  <LogOut className="h-4 w-4" />
                </span>
                <div className="flex-1">
                  <h2 className="text-sm font-bold text-ink">Other signed-in devices</h2>
                  <p className="mt-1 text-sm leading-6 text-muted">
                    Sign out every other browser and device if a phone, computer, or session may be compromised.
                  </p>
                  {!confirmRevoke ? (
                    <button
                      type="button"
                      onClick={() => setConfirmRevoke(true)}
                      className="mt-3 text-sm font-bold text-brand hover:text-brand-dark"
                    >
                      Sign out other sessions
                    </button>
                  ) : (
                    <div className="mt-4 rounded-2xl border border-line bg-surface-subtle p-4">
                      <p className="text-sm text-ink-soft">Your current session will remain signed in. Continue?</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={revokeOtherSessions}
                          disabled={busy !== null}
                          className="btn-primary"
                        >
                          {busy === 'revoke' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                          Confirm sign out
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmRevoke(false)}
                          disabled={busy !== null}
                          className="btn-ghost"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </section>
            )}

            {status.enabled && (
              <section className="surface-card rounded-[1.15rem] p-5 sm:p-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-sm font-bold text-ink">Disable MFA</h2>
                  {status.required && <span className="status-pill status-neutral">Required for this account</span>}
                </div>
                {status.required ? (
                  <p className="mt-2 text-sm leading-6 text-muted">
                    MFA is required for your account because it has privileged access. It cannot be disabled.
                  </p>
                ) : (
                  <>
                    <p className="mt-2 text-sm leading-6 text-muted">
                      This removes your authenticator and all recovery codes, making your account less secure.
                    </p>
                    <button
                      type="button"
                      onClick={() => openFlow('disable')}
                      className="mt-3 text-sm font-bold text-danger hover:text-[#953b3b]"
                    >
                      Disable multi-factor authentication
                    </button>
                  </>
                )}
              </section>
            )}

            <div className="pt-2 text-center">
              <Link href="/dashboard" className="inline-flex items-center gap-2 text-sm font-semibold text-muted underline-offset-4 hover:text-ink hover:underline">
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                Return to dashboard
              </Link>
            </div>
          </div>
        )}

        {flow === 'verify-session' && (
          <section className="surface-card overflow-hidden rounded-[1.35rem] shadow-[var(--shadow-md)]">
            <div className="p-6 sm:p-8">
              <span className="flex h-11 w-11 items-center justify-center rounded-[14px] bg-brand-soft text-brand" aria-hidden="true">
                <LockKeyhole className="h-5 w-5" />
              </span>
              <p className="mt-6 text-[0.66rem] font-bold uppercase tracking-[0.15em] text-brand">Session check</p>
              <h2 className="font-display mt-2 text-[2.15rem] leading-[1.04] tracking-[-0.04em] text-ink">Verify this session.</h2>
              <p className="mt-3 text-sm leading-6 text-muted">
              Enter the current six-digit code from your authenticator app to continue.
              </p>
              <form onSubmit={verify} className="mt-6 space-y-4" aria-busy={busy === 'verify'}>
                <OtpField code={code} setCode={setCode} />
                <PrimaryButton busy={busy === 'verify'}>Verify session</PrimaryButton>
              </form>
            </div>
            <div className="border-t border-line bg-surface-subtle px-6 py-5 sm:px-8">
              <p className="text-xs text-muted">Lost access to this authenticator?</p>
              <button
                type="button"
                onClick={signInWithRecoveryCode}
                disabled={busy !== null}
                className="mt-2 inline-flex items-center gap-2 text-sm font-bold text-brand hover:text-brand-dark disabled:opacity-50"
              >
                {busy === 'recovery-sign-in' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                Sign out and use a recovery code
              </button>
            </div>
          </section>
        )}

        {(flow === 'enroll' || flow === 'replace') && (
          <section className="surface-card rounded-[1.35rem] p-6 shadow-[var(--shadow-md)] sm:p-8">
            <span className="flex h-11 w-11 items-center justify-center rounded-[14px] bg-brand-soft text-brand" aria-hidden="true">
              <Smartphone className="h-5 w-5" />
            </span>
            <p className="mt-6 text-[0.66rem] font-bold uppercase tracking-[0.15em] text-brand">
              {flow === 'replace' ? 'New secure device' : 'Authenticator setup'}
            </p>
            <h2 className="font-display mt-2 text-[2.15rem] leading-[1.04] tracking-[-0.04em] text-ink">
              {flow === 'replace' ? 'Replace your authenticator' : 'Connect an authenticator app'}
            </h2>
            {!qrCodeDataUrl ? (
              <>
                <p className="mt-3 text-sm leading-6 text-muted">
                  {flow === 'replace'
                    ? 'Confirm your password first. Your current authenticator remains active until the new one is successfully verified.'
                    : 'Confirm your password, then scan the QR code with an authenticator app.'}
                </p>
                <form onSubmit={startSetup} className="mt-6 space-y-4" aria-busy={busy === 'setup'}>
                  <PasswordField password={password} setPassword={setPassword} />
                  <PrimaryButton busy={busy === 'setup'}>
                    {flow === 'replace' ? 'Generate replacement QR code' : 'Continue to QR code'}
                  </PrimaryButton>
                </form>
              </>
            ) : (
              <>
                <ol className="mt-5 grid list-inside list-decimal gap-2 text-xs leading-5 text-muted sm:grid-cols-3">
                  <li>Open an authenticator app on the phone you will keep.</li>
                  <li>Scan this QR code.</li>
                  <li>Enter the six-digit code shown by the app.</li>
                </ol>
                <div className="mx-auto mt-6 w-full max-w-[17.25rem] rounded-[1.3rem] border border-line bg-white p-3 shadow-[0_12px_40px_rgba(19,43,35,0.08)] sm:p-4">
                  <Image
                    src={qrCodeDataUrl}
                    alt="QR code for connecting your authenticator app"
                    width={240}
                    height={240}
                    unoptimized
                    className="mx-auto h-auto w-full max-w-[15rem]"
                  />
                </div>
                <div className="alert-warning mt-5">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <p>This QR code contains your secret key. Do not share it, screenshot it, or send it to anyone.</p>
                </div>
                {manualEntryKey && (
                  <details className="mt-4 rounded-2xl border border-line bg-surface-subtle p-4">
                    <summary className="cursor-pointer text-sm font-bold text-ink-soft">
                      Cannot scan the QR code? Enter a setup key
                    </summary>
                    <p className="mt-3 text-xs leading-5 text-muted">
                      In your authenticator app, choose manual entry and use this time-based setup key.
                    </p>
                    <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                      <code className="min-w-0 flex-1 select-all break-all rounded-xl border border-line bg-white px-3 py-2.5 text-sm font-semibold text-brand-dark">
                        {manualEntryKey}
                      </code>
                      <button
                        type="button"
                        onClick={copyManualEntryKey}
                        className="btn-secondary"
                      >
                        {manualKeyCopied
                          ? <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
                          : <Clipboard className="h-4 w-4" aria-hidden="true" />}
                        {manualKeyCopied ? 'Copied' : 'Copy key'}
                      </button>
                    </div>
                  </details>
                )}
                {pendingExpiresAt && (
                  <p className="mt-3 text-center text-xs text-muted">
                    This setup request expires {new Date(pendingExpiresAt).toLocaleString()}.
                  </p>
                )}
                <form onSubmit={verify} className="mt-6 space-y-4" aria-busy={busy === 'verify'}>
                  <OtpField code={code} setCode={setCode} />
                  <PrimaryButton busy={busy === 'verify'}>
                    {flow === 'replace' ? 'Verify and replace authenticator' : 'Verify and enable MFA'}
                  </PrimaryButton>
                </form>
              </>
            )}
            {(flow === 'replace' || !status.required) && (
              <SecondaryButton onClick={cancelSetup} disabled={busy !== null}>
                {flow === 'replace' ? 'Cancel replacement' : 'Cancel'}
              </SecondaryButton>
            )}
          </section>
        )}

        {flow === 'regenerate' && (
          <section className="surface-card rounded-[1.35rem] p-6 shadow-[var(--shadow-md)] sm:p-8">
            <span className="flex h-11 w-11 items-center justify-center rounded-[14px] bg-brand-soft text-brand" aria-hidden="true">
              <KeyRound className="h-5 w-5" />
            </span>
            <p className="mt-6 text-[0.66rem] font-bold uppercase tracking-[0.15em] text-brand">Emergency access</p>
            <h2 className="font-display mt-2 text-[2.15rem] leading-[1.04] tracking-[-0.04em] text-ink">Generate new recovery codes.</h2>
            <p className="mt-3 text-sm leading-6 text-muted">
              Confirm your password and authenticator code. Every unused code from your previous set will stop working immediately.
            </p>
            <div className="alert-warning mt-5">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <p>Your previous recovery codes become invalid as soon as the new set is created.</p>
            </div>
            <form onSubmit={regenerateRecoveryCodes} className="mt-6 space-y-4" aria-busy={busy === 'regenerate'}>
              <PasswordField password={password} setPassword={setPassword} />
              <OtpField code={code} setCode={setCode} />
              <PrimaryButton busy={busy === 'regenerate'}>Replace recovery codes</PrimaryButton>
            </form>
            <SecondaryButton onClick={() => openFlow('overview')} disabled={busy !== null}>Cancel</SecondaryButton>
          </section>
        )}

        {flow === 'disable' && !status.required && (
          <section className="surface-card rounded-[1.35rem] border-[#efd0cc] p-6 shadow-[var(--shadow-md)] sm:p-8">
            <span className="flex h-11 w-11 items-center justify-center rounded-[14px] bg-danger-soft text-danger" aria-hidden="true">
              <ShieldAlert className="h-5 w-5" />
            </span>
            <p className="mt-6 text-[0.66rem] font-bold uppercase tracking-[0.15em] text-danger">Reduce protection</p>
            <h2 className="font-display mt-2 text-[2.15rem] leading-[1.04] tracking-[-0.04em] text-ink">Disable multi-factor authentication.</h2>
            <p className="mt-3 text-sm leading-6 text-muted">
              Confirm with your password and current authenticator code. Your recovery codes will also be invalidated.
            </p>
            <form onSubmit={disableMfa} className="mt-6 space-y-4" aria-busy={busy === 'disable'}>
              <PasswordField password={password} setPassword={setPassword} />
              <OtpField code={code} setCode={setCode} />
              <label className="flex items-start gap-3 rounded-2xl border border-[#efd0cc] bg-danger-soft p-4 text-sm leading-6 text-[#893939]">
                <input
                  type="checkbox"
                  checked={confirmDisable}
                  onChange={(event) => setConfirmDisable(event.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-[#d9a8a3] accent-[#b54747]"
                />
                I understand that password-only login is less secure and all recovery codes will be invalidated.
              </label>
              <button
                type="submit"
                disabled={!confirmDisable || busy !== null}
                className="btn-danger min-h-12 w-full text-sm"
              >
                {busy === 'disable' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                Disable MFA
              </button>
            </form>
            <SecondaryButton onClick={() => openFlow('overview')} disabled={busy !== null}>Cancel</SecondaryButton>
          </section>
        )}

        {flow === 'recovery-codes' && (
          <section className="surface-card rounded-[1.35rem] border-[#cce7dc] p-6 shadow-[var(--shadow-md)] sm:p-8">
            <span className="flex h-11 w-11 items-center justify-center rounded-[14px] bg-success-soft text-success" aria-hidden="true">
              <CheckCircle2 className="h-5 w-5" />
            </span>
            <p className="mt-6 text-[0.66rem] font-bold uppercase tracking-[0.15em] text-success">Authenticator secured</p>
            <h2 className="font-display mt-2 text-[2.15rem] leading-[1.04] tracking-[-0.04em] text-ink">Save your new recovery codes.</h2>
            <p className="mt-3 text-sm leading-6 text-muted">
              Each code works once. These are shown only now, and any older recovery codes are no longer valid.
              Store them somewhere separate from your authenticator device.
            </p>
            <pre className="mt-6 select-all overflow-x-auto rounded-2xl border border-[#cce7dc] bg-[#123027] p-5 text-sm leading-7 tracking-[0.08em] text-[#ccecdf] shadow-inner">
              {recoveryCodes.join('\n')}
            </pre>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={copyRecoveryCodes}
                className="btn-secondary min-h-12"
              >
                {copied ? <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" /> : <Clipboard className="h-4 w-4" aria-hidden="true" />}
                {copied ? 'Copied' : 'Copy codes'}
              </button>
              <button
                type="button"
                onClick={downloadRecoveryCodes}
                className="btn-secondary min-h-12"
              >
                <Download className="h-4 w-4" aria-hidden="true" />
                Download text file
              </button>
            </div>
            <label className="mt-5 flex items-start gap-3 rounded-2xl border border-line bg-surface-subtle p-4 text-sm leading-6 text-ink-soft">
              <input
                type="checkbox"
                checked={recoveryCodesAcknowledged}
                onChange={(event) => setRecoveryCodesAcknowledged(event.target.checked)}
                className="mt-1 h-4 w-4 rounded border-line-strong accent-[#137267]"
              />
              I saved these recovery codes in a secure place. I understand they cannot be displayed again.
            </label>
            <button
              type="button"
              onClick={finishRecoveryCodes}
              disabled={!recoveryCodesAcknowledged}
              className="btn-primary mt-5 min-h-12 w-full text-sm"
            >
              Finish
            </button>
          </section>
        )}
      </div>
    </AuthShell>
  );
}

function PasswordField({
  password,
  setPassword,
}: {
  password: string;
  setPassword: (value: string) => void;
}) {
  return (
    <div>
      <label htmlFor="mfa-current-password" className="ui-label">
        Current password
      </label>
      <input
        id="mfa-current-password"
        name="password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        className="ui-input"
        required
      />
    </div>
  );
}

function OtpField({ code, setCode }: { code: string; setCode: (value: string) => void }) {
  return (
    <div>
      <label htmlFor="mfa-authenticator-code" className="ui-label">
        Authenticator code
      </label>
      <input
        id="mfa-authenticator-code"
        name="code"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        value={code}
        onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 10))}
        placeholder="6-digit code"
        minLength={6}
        maxLength={10}
        className="ui-input font-mono text-base tracking-[0.2em] placeholder:font-sans placeholder:text-sm placeholder:tracking-normal"
        required
      />
    </div>
  );
}

function PrimaryButton({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="btn-primary min-h-12 w-full text-sm"
    >
      {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
      {children}
    </button>
  );
}

function SecondaryButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="btn-ghost mt-3 w-full text-sm"
    >
      {children}
    </button>
  );
}
