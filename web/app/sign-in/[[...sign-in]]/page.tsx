'use client';

import { FormEvent, useEffect, useState } from 'react';
import axios from 'axios';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2, LogIn, Stethoscope } from 'lucide-react';
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
    if (new URLSearchParams(window.location.search).get('invite') === 'accepted') {
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
      await refresh();
      router.replace('/dashboard');
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
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-md bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-2xl">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 bg-blue-600 rounded-lg flex items-center justify-center">
            <Stethoscope className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-white">AI Receptionist</h1>
            <p className="text-sm text-gray-400">Clinic operations portal</p>
          </div>
        </div>

        {notice && (
          <div className="mb-4 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2.5">
            <p className="text-xs text-emerald-300">{notice}</p>
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full text-sm bg-gray-800 border border-gray-700 text-gray-100 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoComplete="email"
              required
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1.5">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full text-sm bg-gray-800 border border-gray-700 text-gray-100 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoComplete="current-password"
              required
            />
          </div>

          {mfaRequired && (
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1.5">
                {useRecoveryCode ? 'Recovery code' : 'Authenticator code'}
              </label>
              <input
                type="text"
                inputMode={useRecoveryCode ? 'text' : 'numeric'}
                value={useRecoveryCode ? recoveryCode : totpCode}
                onChange={(e) => useRecoveryCode
                  ? setRecoveryCode(e.target.value)
                  : setTotpCode(e.target.value)}
                className="w-full text-sm bg-gray-800 border border-gray-700 text-gray-100 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoComplete={useRecoveryCode ? 'off' : 'one-time-code'}
                required={mfaRequired}
              />
              <button
                type="button"
                onClick={() => setUseRecoveryCode((value) => !value)}
                className="mt-2 text-xs text-blue-400 hover:text-blue-300"
              >
                {useRecoveryCode ? 'Use authenticator code' : 'Use a recovery code'}
              </button>
            </div>
          )}
        </div>

        {error && (
          <div className="mt-4 px-3 py-2.5 bg-red-500/10 border border-red-500/20 rounded-lg">
            <p className="text-xs text-red-400">{error}</p>
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="mt-5 w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
          Sign in
        </button>

        <Link href="/forgot-password" className="block text-center text-xs text-blue-400 hover:text-blue-300 mt-4">
          Forgot password?
        </Link>

        <div className="mt-5 border-t border-gray-800 pt-5 text-center">
          <p className="text-xs text-gray-500">Setting up a new clinic organization?</p>
          <Link
            href="/register"
            className="mt-2 inline-flex text-sm font-medium text-blue-400 hover:text-blue-300"
          >
            Create an organization
          </Link>
        </div>
      </form>
    </div>
  );
}
