'use client';

import { FormEvent, useEffect, useState } from 'react';
import axios from 'axios';
import Image from 'next/image';
import Link from 'next/link';
import { CheckCircle2, Loader2, ShieldCheck } from 'lucide-react';
import api from '@/lib/api';
import { useAuth } from '@/lib/auth';

interface MfaStatus {
  required: boolean;
  enabled: boolean;
  sessionVerified: boolean;
}

export default function MfaPage() {
  const { user, loading } = useAuth();
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState('');
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user) return;
    api.get<MfaStatus>('/auth/mfa/status')
      .then(response => setStatus(response.data))
      .catch(() => setError('Unable to load MFA status'));
  }, [user]);

  const setup = async () => {
    setBusy(true);
    setError('');
    try {
      const response = await api.post<{ qrCodeDataUrl: string }>('/auth/mfa/setup');
      setQrCodeDataUrl(response.data.qrCodeDataUrl);
    } catch (err: unknown) {
      const message = axios.isAxiosError(err) ? err.response?.data?.error : undefined;
      setError(message ?? 'Unable to start MFA setup');
    } finally {
      setBusy(false);
    }
  };

  const verify = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await api.post<{ success: boolean; recoveryCodes?: string[] }>(
        '/auth/mfa/verify',
        { code }
      );
      setRecoveryCodes(response.data.recoveryCodes ?? []);
      setVerified(true);
      setStatus(current => current
        ? { ...current, enabled: true, sessionVerified: true }
        : { required: true, enabled: true, sessionVerified: true });
      setCode('');
    } catch (err: unknown) {
      const message = axios.isAxiosError(err) ? err.response?.data?.error : undefined;
      setError(message ?? 'Unable to verify MFA code');
    } finally {
      setBusy(false);
    }
  };

  if (loading || !user || (!status && !error)) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!status) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
        <div className="w-full max-w-md rounded-xl border border-red-500/20 bg-gray-900 p-6 text-sm text-red-300">
          {error || 'Unable to load MFA status'}
        </div>
      </div>
    );
  }

  const enrollmentInProgress = Boolean(qrCodeDataUrl);
  const showVerification = status.enabled || enrollmentInProgress;

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <form onSubmit={verify} className="w-full max-w-md bg-gray-900 border border-gray-800 rounded-xl p-6">
        <ShieldCheck className="w-8 h-8 text-blue-400 mb-4" />
        <h1 className="text-lg font-semibold text-white">
          {status.enabled ? 'Verify your identity' : 'Authenticator app'}
        </h1>
        <p className="text-sm text-gray-400 mt-1 mb-5">
          {status.enabled
            ? 'Enter a fresh authenticator code before changing billing or provider settings.'
            : `Protect ${user.email} with a one-time code.`}
        </p>

        {!showVerification ? (
          <button
            type="button"
            onClick={setup}
            disabled={busy}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            Start setup
          </button>
        ) : (
          <div className="space-y-4">
            {qrCodeDataUrl && (
              <Image
                src={qrCodeDataUrl}
                alt="MFA QR code"
                width={220}
                height={220}
                unoptimized
                className="mx-auto rounded-lg bg-white p-2"
              />
            )}
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 10))}
              placeholder="6-digit code"
              minLength={6}
              maxLength={10}
              className="w-full text-sm bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-600 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
            <button
              type="submit"
              disabled={busy}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              {status.enabled ? 'Verify session' : 'Verify and enable'}
            </button>
          </div>
        )}

        {error && <p className="text-xs text-red-400 mt-3">{error}</p>}

        {verified && recoveryCodes.length === 0 && (
          <div className="mt-5 rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 text-sm text-emerald-300">
            <CheckCircle2 className="mr-2 inline h-4 w-4" />
            Session verified. <Link href="/dashboard" className="underline">Return to dashboard</Link>
          </div>
        )}

        {recoveryCodes.length > 0 && (
          <div className="mt-5 rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3">
            <p className="text-xs text-emerald-300 mb-2">Save these one-time recovery codes now.</p>
            <pre className="text-xs text-emerald-100 whitespace-pre-wrap">{recoveryCodes.join('\n')}</pre>
            <Link href="/dashboard" className="mt-3 inline-block text-xs text-emerald-200 underline">I saved them — return to dashboard</Link>
          </div>
        )}
      </form>
    </div>
  );
}
