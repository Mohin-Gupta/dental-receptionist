'use client';

import { FormEvent, useState } from 'react';
import axios from 'axios';
import Image from 'next/image';
import { Loader2, ShieldCheck } from 'lucide-react';
import api from '@/lib/api';
import { useAuth } from '@/lib/auth';

export default function MfaPage() {
  const { user, loading } = useAuth();
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState('');
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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
      const response = await api.post<{ recoveryCodes: string[] }>('/auth/mfa/verify', { code });
      setRecoveryCodes(response.data.recoveryCodes);
    } catch (err: unknown) {
      const message = axios.isAxiosError(err) ? err.response?.data?.error : undefined;
      setError(message ?? 'Unable to verify MFA code');
    } finally {
      setBusy(false);
    }
  };

  if (loading || !user) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <form onSubmit={verify} className="w-full max-w-md bg-gray-900 border border-gray-800 rounded-xl p-6">
        <ShieldCheck className="w-8 h-8 text-blue-400 mb-4" />
        <h1 className="text-lg font-semibold text-white">Authenticator app</h1>
        <p className="text-sm text-gray-400 mt-1 mb-5">Protect {user.email} with a one-time code.</p>

        {!qrCodeDataUrl ? (
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
            <Image
              src={qrCodeDataUrl}
              alt="MFA QR code"
              width={220}
              height={220}
              unoptimized
              className="mx-auto rounded-lg bg-white p-2"
            />
            <input
              type="text"
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="6-digit code"
              className="w-full text-sm bg-gray-800 border border-gray-700 text-gray-100 placeholder-gray-600 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
            <button
              type="submit"
              disabled={busy}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" />}
              Verify and enable
            </button>
          </div>
        )}

        {error && <p className="text-xs text-red-400 mt-3">{error}</p>}

        {recoveryCodes.length > 0 && (
          <div className="mt-5 rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3">
            <p className="text-xs text-emerald-300 mb-2">Save these recovery codes now.</p>
            <pre className="text-xs text-emerald-100 whitespace-pre-wrap">{recoveryCodes.join('\n')}</pre>
          </div>
        )}
      </form>
    </div>
  );
}
