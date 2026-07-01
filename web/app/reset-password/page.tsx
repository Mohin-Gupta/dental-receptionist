'use client';

import { FormEvent, Suspense, useState } from 'react';
import axios from 'axios';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Loader2, LockKeyhole } from 'lucide-react';
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
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-md bg-gray-900 border border-gray-800 rounded-xl p-6">
        <LockKeyhole className="w-8 h-8 text-blue-400 mb-4" />
        <h1 className="text-lg font-semibold text-white">Choose a new password</h1>
        <p className="text-sm text-gray-400 mt-1 mb-5">Use at least 12 characters.</p>

        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full text-sm bg-gray-800 border border-gray-700 text-gray-100 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
          minLength={12}
          required
        />

        {error && <p className="text-xs text-red-400 mt-3">{error}</p>}
        {done && <p className="text-xs text-emerald-400 mt-3">Password reset. You can sign in now.</p>}

        <button
          type="submit"
          disabled={loading || !token || done}
          className="mt-5 w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50"
        >
          {loading && <Loader2 className="w-4 h-4 animate-spin" />}
          Reset password
        </button>

        <Link href="/sign-in" className="block text-center text-xs text-blue-400 hover:text-blue-300 mt-4">
          Back to sign in
        </Link>
      </form>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-950" />}>
      <ResetPasswordContent />
    </Suspense>
  );
}
