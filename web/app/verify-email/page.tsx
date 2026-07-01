'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { CheckCircle, Loader2, XCircle } from 'lucide-react';
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
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-gray-900 border border-gray-800 rounded-xl p-6 text-center">
        {status === 'loading' && <Loader2 className="w-8 h-8 text-blue-400 animate-spin mx-auto mb-4" />}
        {status === 'success' && <CheckCircle className="w-8 h-8 text-emerald-400 mx-auto mb-4" />}
        {status === 'error' && <XCircle className="w-8 h-8 text-red-400 mx-auto mb-4" />}
        <h1 className="text-lg font-semibold text-white">
          {status === 'success' ? 'Email verified' : status === 'error' ? 'Verification failed' : 'Verifying email'}
        </h1>
        <Link href="/sign-in" className="inline-block text-xs text-blue-400 hover:text-blue-300 mt-5">
          Back to sign in
        </Link>
      </div>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-950" />}>
      <VerifyEmailContent />
    </Suspense>
  );
}
