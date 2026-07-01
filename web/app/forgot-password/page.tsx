'use client';

import { FormEvent, useState } from 'react';
import Link from 'next/link';
import { Loader2, Mail } from 'lucide-react';
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
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-md bg-gray-900 border border-gray-800 rounded-xl p-6">
        <Mail className="w-8 h-8 text-blue-400 mb-4" />
        <h1 className="text-lg font-semibold text-white">Reset password</h1>
        <p className="text-sm text-gray-400 mt-1 mb-5">
          Enter your email and we will send reset instructions if the account exists.
        </p>

        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full text-sm bg-gray-800 border border-gray-700 text-gray-100 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500"
          required
        />

        {sent && <p className="text-xs text-emerald-400 mt-3">Check your email for a reset link.</p>}

        <button
          type="submit"
          disabled={loading}
          className="mt-5 w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50"
        >
          {loading && <Loader2 className="w-4 h-4 animate-spin" />}
          Send reset link
        </button>

        <Link href="/sign-in" className="block text-center text-xs text-blue-400 hover:text-blue-300 mt-4">
          Back to sign in
        </Link>
      </form>
    </div>
  );
}
