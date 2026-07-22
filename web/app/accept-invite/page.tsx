'use client';

import { FormEvent, Suspense, useState } from 'react';
import axios from 'axios';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, UserPlus } from 'lucide-react';
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
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-md bg-gray-900 border border-gray-800 rounded-xl p-6">
        <UserPlus className="w-8 h-8 text-blue-400 mb-4" />
        <h1 className="text-lg font-semibold text-white">Join your clinic workspace</h1>
        <p className="text-sm text-gray-400 mt-1 mb-5">
          New users create their account here. Existing users should enter their current account details.
        </p>

        <div className="space-y-4">
          <label className="block text-xs font-medium text-gray-400">
            Full name
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              maxLength={120}
              className="mt-1.5 w-full text-sm bg-gray-800 border border-gray-700 text-gray-100 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
          </label>
          <label className="block text-xs font-medium text-gray-400">
            Account password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              minLength={12}
              maxLength={200}
              className="mt-1.5 w-full text-sm bg-gray-800 border border-gray-700 text-gray-100 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
            <span className="mt-1 block font-normal text-gray-600">
              Use your existing password, or create one with at least 12 characters.
            </span>
          </label>
        </div>

        {!token && <p className="text-xs text-amber-400 mt-3">This invitation link is incomplete. Request a new invite from your organization owner.</p>}
        {error && <p className="text-xs text-red-400 mt-3">{error}</p>}

        <button
          type="submit"
          disabled={loading || !token}
          className="mt-5 w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50"
        >
          {loading && <Loader2 className="w-4 h-4 animate-spin" />}
          Accept invite
        </button>
      </form>
    </div>
  );
}

export default function AcceptInvitePage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-950" />}>
      <AcceptInviteContent />
    </Suspense>
  );
}
