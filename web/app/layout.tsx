import type { Metadata } from 'next';
import { AuthProvider } from '@/lib/auth';
import '@fontsource-variable/manrope';
import '@fontsource-variable/newsreader';
import './globals.css';

export const metadata: Metadata = {
  title: 'Comeigo — Clinic intelligence',
  description: 'AI-powered patient communication and clinic operations, beautifully coordinated.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
