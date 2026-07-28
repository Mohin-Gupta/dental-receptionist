'use client';

import { type FormEvent, useEffect, useState } from 'react';
import axios from 'axios';
import Image from 'next/image';
import Link from 'next/link';
import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  Download,
  KeyRound,
  Loader2,
  LockKeyhole,
  LogOut,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
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
      'Dental Receptionist MFA recovery codes',
      `Generated: ${new Date().toISOString()}`,
      '',
      ...recoveryCodes,
      '',
      'Each code can be used once. Store these codes somewhere separate from your authenticator device.',
    ].join('\n');
    const objectUrl = URL.createObjectURL(new Blob([contents], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = 'dental-receptionist-recovery-codes.txt';
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
      <main className="flex min-h-screen items-center justify-center bg-gray-950" aria-busy="true">
        <Loader2 className="h-7 w-7 animate-spin text-blue-400" aria-label="Loading account security" />
      </main>
    );
  }

  if (!user) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gray-950 px-4">
        <section className="w-full max-w-md rounded-xl border border-gray-800 bg-gray-900 p-6 text-center">
          <ShieldCheck className="mx-auto mb-4 h-8 w-8 text-blue-400" />
          <h1 className="text-lg font-semibold text-white">Sign in to manage MFA</h1>
          <p className="mt-2 text-sm text-gray-400">Your security settings are available after you sign in.</p>
          <Link href="/sign-in" className="mt-5 inline-flex rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700">
            Go to sign in
          </Link>
        </section>
      </main>
    );
  }

  if (!status) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gray-950 px-4">
        <section className="w-full max-w-md rounded-xl border border-red-500/20 bg-gray-900 p-6">
          <ShieldAlert className="mb-4 h-8 w-8 text-red-400" />
          <h1 className="text-lg font-semibold text-white">Unable to load security settings</h1>
          <p className="mt-2 text-sm text-red-300" role="alert">{error}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-5 inline-flex items-center gap-2 rounded-lg bg-gray-800 px-4 py-2.5 text-sm font-medium text-white hover:bg-gray-700"
          >
            <RefreshCw className="h-4 w-4" />
            Try again
          </button>
        </section>
      </main>
    );
  }

  const recoveryLogin = status.sessionVerificationMethod === 'recovery_code';
  const legacyVerifiedSession = status.sessionVerified && status.sessionVerificationMethod === null;
  const lowOnRecoveryCodes = status.enabled && status.recoveryCodesRemaining <= 3;

  return (
    <main className="min-h-screen bg-gray-950 px-4 py-10 text-gray-100">
      <div className="mx-auto w-full max-w-2xl">
        <header className="mb-6">
          <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-blue-500/10">
            <ShieldCheck className="h-6 w-6 text-blue-400" />
          </div>
          <h1 className="text-2xl font-semibold text-white">Multi-factor authentication</h1>
          <p className="mt-2 text-sm text-gray-400">
            Protect {user.email} with an authenticator app and one-time recovery codes.
          </p>
        </header>

        <div aria-live="polite" aria-atomic="true">
          {error && (
            <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-300" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div className="mb-4 rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 text-sm text-emerald-300">
              <CheckCircle2 className="mr-2 inline h-4 w-4" />
              {notice}
            </div>
          )}
        </div>

        {flow === 'overview' && (
          <div className="space-y-4">
            {(status.replacementRecommended || recoveryLogin) && (
              <section className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-5">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
                  <div>
                    <h2 className="font-medium text-amber-100">
                      {legacyVerifiedSession
                        ? 'Authenticator recovery recommended'
                        : 'You signed in with a recovery code'}
                    </h2>
                    <p className="mt-1 text-sm leading-6 text-amber-200/80">
                      {legacyVerifiedSession
                        ? 'This session was created before MFA verification methods were tracked. If your authenticator was lost or compromised, replace it now.'
                        : 'One recovery code has been permanently consumed. If your authenticator was lost or compromised, replace it now so you can use normal six-digit codes again.'}
                    </p>
                    <button
                      type="button"
                      onClick={() => openFlow('replace')}
                      className="mt-4 rounded-lg bg-amber-300 px-4 py-2.5 text-sm font-semibold text-gray-950 hover:bg-amber-200"
                    >
                      Replace authenticator now
                    </button>
                  </div>
                </div>
              </section>
            )}

            <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h2 className="font-medium text-white">Security status</h2>
                  <p className="mt-1 text-sm text-gray-400">
                    {status.enabled ? 'An authenticator app is connected.' : 'No authenticator app is connected.'}
                  </p>
                </div>
                <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                  status.enabled
                    ? 'bg-emerald-500/10 text-emerald-300'
                    : 'bg-gray-800 text-gray-300'
                }`}>
                  {status.enabled ? 'MFA enabled' : 'MFA disabled'}
                </span>
              </div>

              {status.enabled && (
                <dl className="mt-5 grid gap-3 border-t border-gray-800 pt-5 sm:grid-cols-2">
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-gray-500">Current session</dt>
                    <dd className="mt-1 text-sm text-gray-200">
                      {status.sessionVerified
                        ? legacyVerifiedSession
                          ? 'Verified by a legacy MFA session'
                          : `Verified by ${recoveryLogin ? 'recovery code' : 'authenticator'}`
                        : 'Verification required'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-gray-500">Emergency access</dt>
                    <dd className={`mt-1 text-sm ${lowOnRecoveryCodes ? 'text-amber-300' : 'text-gray-200'}`}>
                      {recoveryCodeCountLabel(status.recoveryCodesRemaining)}
                    </dd>
                  </div>
                </dl>
              )}

              {status.pendingSetup && (
                <div className="mt-4 rounded-lg border border-blue-400/20 bg-blue-400/10 p-3 text-sm leading-6 text-blue-200">
                  An authenticator setup is waiting for verification. Your active authenticator has not been changed.
                  Start the setup again in this browser if you no longer have its QR code.
                </div>
              )}

              {!status.enabled && (
                <button
                  type="button"
                  onClick={() => openFlow('enroll')}
                  className="mt-5 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
                >
                  <Smartphone className="h-4 w-4" />
                  Set up authenticator
                </button>
              )}
            </section>

            {status.enabled && (
              <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
                <h2 className="font-medium text-white">Manage MFA</h2>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => openFlow('replace')}
                    className="rounded-lg border border-gray-700 bg-gray-800 p-4 text-left hover:border-gray-600 hover:bg-gray-700"
                  >
                    <RefreshCw className="mb-2 h-5 w-5 text-blue-400" />
                    <span className="block text-sm font-medium text-white">Replace authenticator</span>
                    <span className="mt-1 block text-xs leading-5 text-gray-400">Connect a new phone without disabling the current method first.</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => openFlow('regenerate')}
                    className="rounded-lg border border-gray-700 bg-gray-800 p-4 text-left hover:border-gray-600 hover:bg-gray-700"
                  >
                    <KeyRound className="mb-2 h-5 w-5 text-blue-400" />
                    <span className="block text-sm font-medium text-white">Generate new recovery codes</span>
                    <span className="mt-1 block text-xs leading-5 text-gray-400">Immediately invalidate every unused old recovery code.</span>
                  </button>
                </div>

                {lowOnRecoveryCodes && (
                  <div className="mt-4 rounded-lg border border-amber-400/20 bg-amber-400/10 p-3 text-sm text-amber-200">
                    You are low on recovery codes. Generate a new set before you need emergency access.
                  </div>
                )}
              </section>
            )}

            {status.enabled && (
            <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
              <div className="flex items-start gap-3">
                <LogOut className="mt-0.5 h-5 w-5 shrink-0 text-gray-400" />
                <div className="flex-1">
                  <h2 className="font-medium text-white">Other signed-in devices</h2>
                  <p className="mt-1 text-sm leading-6 text-gray-400">
                    Sign out every other browser and device if a phone, computer, or session may be compromised.
                  </p>
                  {!confirmRevoke ? (
                    <button
                      type="button"
                      onClick={() => setConfirmRevoke(true)}
                      className="mt-3 text-sm font-medium text-blue-300 hover:text-blue-200"
                    >
                      Sign out other sessions
                    </button>
                  ) : (
                    <div className="mt-4 rounded-lg border border-gray-700 bg-gray-950/60 p-3">
                      <p className="text-sm text-gray-300">Your current session will remain signed in. Continue?</p>
                      <div className="mt-3 flex gap-2">
                        <button
                          type="button"
                          onClick={revokeOtherSessions}
                          disabled={busy !== null}
                          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                        >
                          {busy === 'revoke' && <Loader2 className="h-4 w-4 animate-spin" />}
                          Confirm sign out
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmRevoke(false)}
                          disabled={busy !== null}
                          className="rounded-lg px-3 py-2 text-sm text-gray-300 hover:bg-gray-800 disabled:opacity-50"
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
              <section className="rounded-xl border border-gray-800 bg-gray-900 p-5">
                <h2 className="font-medium text-white">Disable MFA</h2>
                {status.required ? (
                  <p className="mt-1 text-sm leading-6 text-gray-400">
                    MFA is required for your account because it has privileged access. It cannot be disabled.
                  </p>
                ) : (
                  <>
                    <p className="mt-1 text-sm leading-6 text-gray-400">
                      This removes your authenticator and all recovery codes, making your account less secure.
                    </p>
                    <button
                      type="button"
                      onClick={() => openFlow('disable')}
                      className="mt-3 text-sm font-medium text-red-300 hover:text-red-200"
                    >
                      Disable multi-factor authentication
                    </button>
                  </>
                )}
              </section>
            )}

            <div className="pt-2 text-center">
              <Link href="/dashboard" className="text-sm text-gray-400 underline-offset-4 hover:text-gray-200 hover:underline">
                Return to dashboard
              </Link>
            </div>
          </div>
        )}

        {flow === 'verify-session' && (
          <section className="rounded-xl border border-gray-800 bg-gray-900 p-6">
            <LockKeyhole className="mb-4 h-7 w-7 text-blue-400" />
            <h2 className="text-lg font-semibold text-white">Verify this session</h2>
            <p className="mt-2 text-sm leading-6 text-gray-400">
              Enter the current six-digit code from your authenticator app to continue.
            </p>
            <form onSubmit={verify} className="mt-5 space-y-4">
              <OtpField code={code} setCode={setCode} />
              <PrimaryButton busy={busy === 'verify'}>Verify session</PrimaryButton>
            </form>
            <div className="mt-5 border-t border-gray-800 pt-4">
              <p className="text-sm text-gray-400">Lost access to this authenticator?</p>
              <button
                type="button"
                onClick={signInWithRecoveryCode}
                disabled={busy !== null}
                className="mt-2 inline-flex items-center gap-2 text-sm font-medium text-blue-300 hover:text-blue-200 disabled:opacity-50"
              >
                {busy === 'recovery-sign-in' && <Loader2 className="h-4 w-4 animate-spin" />}
                Sign out and use a recovery code
              </button>
            </div>
          </section>
        )}

        {(flow === 'enroll' || flow === 'replace') && (
          <section className="rounded-xl border border-gray-800 bg-gray-900 p-6">
            <Smartphone className="mb-4 h-7 w-7 text-blue-400" />
            <h2 className="text-lg font-semibold text-white">
              {flow === 'replace' ? 'Replace your authenticator' : 'Connect an authenticator app'}
            </h2>
            {!qrCodeDataUrl ? (
              <>
                <p className="mt-2 text-sm leading-6 text-gray-400">
                  {flow === 'replace'
                    ? 'Confirm your password first. Your current authenticator remains active until the new one is successfully verified.'
                    : 'Confirm your password, then scan the QR code with an authenticator app.'}
                </p>
                <form onSubmit={startSetup} className="mt-5 space-y-4">
                  <PasswordField password={password} setPassword={setPassword} />
                  <PrimaryButton busy={busy === 'setup'}>
                    {flow === 'replace' ? 'Generate replacement QR code' : 'Continue to QR code'}
                  </PrimaryButton>
                </form>
              </>
            ) : (
              <>
                <ol className="mt-2 list-inside list-decimal space-y-1 text-sm leading-6 text-gray-400">
                  <li>Open an authenticator app on the phone you will keep.</li>
                  <li>Scan this QR code.</li>
                  <li>Enter the six-digit code shown by the app.</li>
                </ol>
                <div className="mt-5 rounded-xl bg-white p-3">
                  <Image
                    src={qrCodeDataUrl}
                    alt="QR code for connecting your authenticator app"
                    width={240}
                    height={240}
                    unoptimized
                    className="mx-auto"
                  />
                </div>
                <p className="mt-3 text-xs leading-5 text-amber-300">
                  This QR code contains your secret key. Do not share it, screenshot it, or send it to anyone.
                </p>
                {manualEntryKey && (
                  <details className="mt-3 rounded-lg border border-gray-700 bg-gray-950/60 p-3">
                    <summary className="cursor-pointer text-sm font-medium text-gray-200">
                      Cannot scan the QR code? Enter a setup key
                    </summary>
                    <p className="mt-3 text-xs leading-5 text-gray-400">
                      In your authenticator app, choose manual entry and use this time-based setup key.
                    </p>
                    <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                      <code className="min-w-0 flex-1 select-all break-all rounded bg-gray-900 px-3 py-2 text-sm text-blue-200">
                        {manualEntryKey}
                      </code>
                      <button
                        type="button"
                        onClick={copyManualEntryKey}
                        className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm font-medium text-white hover:bg-gray-700"
                      >
                        {manualKeyCopied
                          ? <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                          : <Clipboard className="h-4 w-4" />}
                        {manualKeyCopied ? 'Copied' : 'Copy key'}
                      </button>
                    </div>
                  </details>
                )}
                {pendingExpiresAt && (
                  <p className="mt-2 text-xs text-gray-500">
                    This setup request expires {new Date(pendingExpiresAt).toLocaleString()}.
                  </p>
                )}
                <form onSubmit={verify} className="mt-5 space-y-4">
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
          <section className="rounded-xl border border-gray-800 bg-gray-900 p-6">
            <KeyRound className="mb-4 h-7 w-7 text-blue-400" />
            <h2 className="text-lg font-semibold text-white">Generate new recovery codes</h2>
            <p className="mt-2 text-sm leading-6 text-gray-400">
              Confirm your password and authenticator code. Every unused code from your previous set will stop working immediately.
            </p>
            <form onSubmit={regenerateRecoveryCodes} className="mt-5 space-y-4">
              <PasswordField password={password} setPassword={setPassword} />
              <OtpField code={code} setCode={setCode} />
              <PrimaryButton busy={busy === 'regenerate'}>Replace recovery codes</PrimaryButton>
            </form>
            <SecondaryButton onClick={() => openFlow('overview')} disabled={busy !== null}>Cancel</SecondaryButton>
          </section>
        )}

        {flow === 'disable' && !status.required && (
          <section className="rounded-xl border border-red-500/20 bg-gray-900 p-6">
            <ShieldAlert className="mb-4 h-7 w-7 text-red-400" />
            <h2 className="text-lg font-semibold text-white">Disable multi-factor authentication</h2>
            <p className="mt-2 text-sm leading-6 text-gray-400">
              Confirm with your password and current authenticator code. Your recovery codes will also be invalidated.
            </p>
            <form onSubmit={disableMfa} className="mt-5 space-y-4">
              <PasswordField password={password} setPassword={setPassword} />
              <OtpField code={code} setCode={setCode} />
              <label className="flex items-start gap-3 rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-200">
                <input
                  type="checkbox"
                  checked={confirmDisable}
                  onChange={(event) => setConfirmDisable(event.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-gray-600 bg-gray-800"
                />
                I understand that password-only login is less secure and all recovery codes will be invalidated.
              </label>
              <button
                type="submit"
                disabled={!confirmDisable || busy !== null}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === 'disable' && <Loader2 className="h-4 w-4 animate-spin" />}
                Disable MFA
              </button>
            </form>
            <SecondaryButton onClick={() => openFlow('overview')} disabled={busy !== null}>Cancel</SecondaryButton>
          </section>
        )}

        {flow === 'recovery-codes' && (
          <section className="rounded-xl border border-emerald-500/20 bg-gray-900 p-6">
            <CheckCircle2 className="mb-4 h-7 w-7 text-emerald-400" />
            <h2 className="text-lg font-semibold text-white">Save your new recovery codes</h2>
            <p className="mt-2 text-sm leading-6 text-gray-400">
              Each code works once. These are shown only now, and any older recovery codes are no longer valid.
              Store them somewhere separate from your authenticator device.
            </p>
            <pre className="mt-5 select-all overflow-x-auto rounded-lg border border-gray-700 bg-gray-950 p-4 text-sm leading-7 text-emerald-200">
              {recoveryCodes.join('\n')}
            </pre>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={copyRecoveryCodes}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm font-medium text-white hover:bg-gray-700"
              >
                {copied ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <Clipboard className="h-4 w-4" />}
                {copied ? 'Copied' : 'Copy codes'}
              </button>
              <button
                type="button"
                onClick={downloadRecoveryCodes}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm font-medium text-white hover:bg-gray-700"
              >
                <Download className="h-4 w-4" />
                Download text file
              </button>
            </div>
            <label className="mt-5 flex items-start gap-3 rounded-lg border border-gray-700 bg-gray-800/60 p-3 text-sm text-gray-200">
              <input
                type="checkbox"
                checked={recoveryCodesAcknowledged}
                onChange={(event) => setRecoveryCodesAcknowledged(event.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-gray-600 bg-gray-800"
              />
              I saved these recovery codes in a secure place. I understand they cannot be displayed again.
            </label>
            <button
              type="button"
              onClick={finishRecoveryCodes}
              disabled={!recoveryCodesAcknowledged}
              className="mt-4 w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Finish
            </button>
          </section>
        )}
      </div>
    </main>
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
      <label htmlFor="mfa-current-password" className="mb-1.5 block text-sm font-medium text-gray-200">
        Current password
      </label>
      <input
        id="mfa-current-password"
        name="password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-sm text-gray-100 outline-none placeholder:text-gray-600 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30"
        required
      />
    </div>
  );
}

function OtpField({ code, setCode }: { code: string; setCode: (value: string) => void }) {
  return (
    <div>
      <label htmlFor="mfa-authenticator-code" className="mb-1.5 block text-sm font-medium text-gray-200">
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
        className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-sm tracking-widest text-gray-100 outline-none placeholder:tracking-normal placeholder:text-gray-600 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30"
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
      className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {busy && <Loader2 className="h-4 w-4 animate-spin" />}
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
      className="mt-3 w-full rounded-lg px-4 py-2.5 text-sm font-medium text-gray-300 hover:bg-gray-800 disabled:opacity-50"
    >
      {children}
    </button>
  );
}
