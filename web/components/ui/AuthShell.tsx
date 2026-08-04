'use client';

import type { ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { CalendarCheck2, CheckCircle2, Headphones, ShieldCheck, Sparkles } from 'lucide-react';
import BrandMark from './BrandMark';
import { cn } from '@/lib/cn';

interface AuthShellProps {
  children: ReactNode;
  wide?: boolean;
  className?: string;
}

export default function AuthShell({ children, wide = false, className }: AuthShellProps) {
  const reduceMotion = useReducedMotion();

  return (
    <main className="grid min-h-dvh bg-[#f3f6f4] lg:grid-cols-[minmax(380px,0.88fr)_minmax(560px,1.12fr)]">
      <aside className="relative hidden min-h-dvh overflow-hidden bg-[#122720] px-10 py-9 text-white lg:flex lg:flex-col xl:px-14 xl:py-11">
        <div
          className="pointer-events-none absolute inset-0 opacity-70"
          style={{
            background:
              'radial-gradient(circle at 20% 8%, rgba(89,170,146,.23), transparent 28rem), radial-gradient(circle at 95% 82%, rgba(222,184,115,.12), transparent 25rem)',
          }}
        />
        <div className="pointer-events-none absolute -right-24 top-1/3 h-80 w-80 rounded-full border border-white/[0.06]" />
        <div className="pointer-events-none absolute -right-8 top-[38%] h-52 w-52 rounded-full border border-white/[0.06]" />

        <BrandMark inverted className="relative z-10" />

        <div className="relative z-10 my-auto max-w-xl py-14">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.055] px-3 py-1.5 text-[0.66rem] font-bold uppercase tracking-[0.16em] text-[#b8d2c9]">
            <Sparkles className="h-3.5 w-3.5 text-[#d9b66f]" />
            The calmer way to run a clinic
          </div>
          <p className="font-display max-w-lg text-[clamp(2.6rem,4vw,4.55rem)] font-normal leading-[0.98] tracking-[-0.05em] text-[#f5faf7]">
            Every patient call, thoughtfully handled.
          </p>
          <p className="mt-6 max-w-lg text-sm leading-7 text-[#afc5bd]">
            Maya keeps the front desk composed—from first hello to confirmed appointment—while your team stays focused on care.
          </p>

          <motion.div
            initial={reduceMotion ? false : { opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.12, ease: [0.22, 1, 0.36, 1] }}
            className="mt-9 max-w-lg overflow-hidden rounded-[1.35rem] border border-white/10 bg-white/[0.065] p-4 shadow-[0_24px_80px_rgba(0,0,0,0.18)] backdrop-blur"
          >
            <div className="flex items-center justify-between border-b border-white/[0.08] pb-3">
              <div className="flex items-center gap-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-[#dff3ed] text-[#0f665a]">
                  <Headphones className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-xs font-semibold text-white">Maya is answering</p>
                  <p className="mt-0.5 text-[0.62rem] text-[#9eb8af]">New patient inquiry · 02:14</p>
                </div>
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[#204c3f] px-2.5 py-1 text-[0.62rem] font-semibold text-[#bde4d7]">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#78d5b7]" /> Live
              </span>
            </div>

            <div className="flex h-16 items-center gap-1 px-1" aria-hidden="true">
              {[12, 20, 31, 18, 38, 48, 27, 18, 35, 26, 44, 30, 16, 22, 12, 29, 19, 10].map((height, index) => (
                <span
                  key={`${height}-${index}`}
                  className="w-full rounded-full bg-[#77bba6]"
                  style={{ height, opacity: 0.3 + (index % 4) * 0.12 }}
                />
              ))}
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-xl bg-[#0e211b]/55 p-3">
                <p className="text-[0.6rem] font-bold uppercase tracking-[0.13em] text-[#82a398]">Patient intent</p>
                <p className="mt-1.5 text-xs font-medium text-[#edf7f3]">Book a consultation</p>
              </div>
              <div className="rounded-xl bg-[#0e211b]/55 p-3">
                <p className="text-[0.6rem] font-bold uppercase tracking-[0.13em] text-[#82a398]">Next action</p>
                <p className="mt-1.5 flex items-center gap-1.5 text-xs font-medium text-[#edf7f3]">
                  <CalendarCheck2 className="h-3.5 w-3.5 text-[#8fd1bd]" /> Confirming a slot
                </p>
              </div>
            </div>
          </motion.div>
        </div>

        <div className="relative z-10 flex flex-wrap gap-x-6 gap-y-2 text-[0.66rem] font-medium text-[#91ada3]">
          <span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5" /> Secure by design</span>
          <span className="inline-flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5" /> Built for multi-location clinics</span>
        </div>
      </aside>

      <section className="relative flex min-h-dvh flex-col overflow-hidden px-4 py-5 sm:px-8 sm:py-8 lg:px-12 xl:px-20">
        <div className="pointer-events-none absolute -right-20 -top-24 h-80 w-80 rounded-full bg-[#dceee8]/65 blur-3xl" />
        <BrandMark className="relative z-10 lg:hidden" />

        <div className="relative z-10 flex flex-1 items-center justify-center py-8 lg:py-12">
          <motion.div
            initial={reduceMotion ? false : { opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            className={cn('w-full', wide ? 'max-w-3xl' : 'max-w-[30rem]', className)}
          >
            {children}
          </motion.div>
        </div>

        <footer className="relative z-10 text-center text-[0.7rem] leading-5 text-[#61716b]">
          Designed for calm, connected clinic operations.
        </footer>
      </section>
    </main>
  );
}
