'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import type { AuthClinic, AuthOrganization } from '@/lib/api';
import BrandMark from '@/components/ui/BrandMark';
import {
  LayoutDashboard,
  Calendar,
  Users,
  Phone,
  Settings,
  Building2,
  Menu,
  X,
  LogOut,
  CreditCard,
  PlugZap,
  UsersRound,
  ShieldCheck,
  ChevronDown,
  MapPin,
} from 'lucide-react';

const navItems = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard, access: 'all', section: 'Workspace' },
  { href: '/dashboard/appointments', label: 'Appointments', icon: Calendar, access: 'all', section: 'Workspace' },
  { href: '/dashboard/patients', label: 'Patients', icon: Users, access: 'all', section: 'Workspace' },
  { href: '/dashboard/calls', label: 'Call logs', icon: Phone, access: 'all', section: 'Workspace' },
  { href: '/dashboard/billing', label: 'Billing & usage', icon: CreditCard, access: 'billing', section: 'Administration' },
  { href: '/dashboard/integrations', label: 'Integrations', icon: PlugZap, access: 'integrations', section: 'Administration' },
  { href: '/dashboard/organization', label: 'Organization', icon: UsersRound, access: 'users', section: 'Administration' },
  { href: '/dashboard/settings', label: 'Clinic settings', icon: Settings, access: 'settings', section: 'Administration' },
] as const;

interface SidebarProps {
  pathname: string;
  name?: string;
  email?: string;
  role?: string | null;
  activeOrganizationId?: string | null;
  activeClinicId?: string | null;
  organizations: AuthOrganization[];
  clinics: AuthClinic[];
  canManageSettings: boolean;
  canManageUsers: boolean;
  canReadBilling: boolean;
  canManageIntegrations: boolean;
  closeMenu?: () => void;
  onLogout: () => void;
  onScopeChange: (organizationId: string, clinicId: string) => void;
}

function SidebarContent({
  pathname,
  name,
  email,
  role,
  activeOrganizationId,
  activeClinicId,
  organizations,
  clinics,
  canManageSettings,
  canManageUsers,
  canReadBilling,
  canManageIntegrations,
  closeMenu,
  onLogout,
  onScopeChange,
}: SidebarProps) {
  const visibleNavItems = navItems.filter((item) => {
    if (item.access === 'settings') return canManageSettings;
    if (item.access === 'users') return canManageUsers;
    if (item.access === 'billing') return canReadBilling;
    if (item.access === 'integrations') return canManageIntegrations;
    return true;
  });
  const activeOrganizationName = organizations.find(
    (organization) => organization.id === activeOrganizationId
  )?.name;
  const activeClinicName = clinics.find((clinic) => clinic.id === activeClinicId)?.name;
  const sections = ['Workspace', 'Administration'] as const;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-white/[0.09] px-5 py-5">
        <BrandMark inverted />
      </div>

      <div className="px-4 pb-3 pt-4">
        <div className="rounded-2xl border border-white/[0.1] bg-white/[0.055] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <div className="mb-3 flex items-center gap-2 text-[0.62rem] font-bold uppercase tracking-[0.16em] text-[#89aa9e]">
            <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
            Active location
          </div>

          {organizations.length > 1 ? (
            <label className="relative block">
              <span className="sr-only">Organization</span>
              <select
                value={activeOrganizationId ?? ''}
                onChange={(event) => {
                  const organizationId = event.target.value;
                  const firstClinic = clinics.find((clinic) => clinic.organizationId === organizationId);
                  if (firstClinic) onScopeChange(organizationId, firstClinic.id);
                }}
                className="mb-2 min-h-9 w-full appearance-none rounded-xl border border-white/[0.1] bg-[#0d211b] py-2 pl-3 pr-8 text-xs font-semibold text-white outline-none transition hover:border-white/20 focus:border-[#72b9a3] focus:ring-2 focus:ring-[#72b9a3]/20"
              >
                {organizations.map((organization) => (
                  <option key={organization.id} value={organization.id}>
                    {organization.name}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 h-3.5 w-3.5 text-[#89aa9e]" aria-hidden="true" />
            </label>
          ) : (
            <p className="mb-1 truncate text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-[#89aa9e]">
              {activeOrganizationName ?? 'Maya'}
            </p>
          )}

          <label className="relative block">
            <span className="sr-only">Clinic</span>
            <Building2 className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#89aa9e]" aria-hidden="true" />
            <select
              value={activeClinicId ?? ''}
              onChange={(event) => {
                const clinic = clinics.find((item) => item.id === event.target.value);
                if (clinic) onScopeChange(clinic.organizationId, clinic.id);
              }}
              className="min-h-10 w-full appearance-none truncate rounded-xl border border-white/[0.1] bg-[#0d211b] py-2 pl-9 pr-8 text-sm font-semibold text-white outline-none transition hover:border-white/20 focus:border-[#72b9a3] focus:ring-2 focus:ring-[#72b9a3]/20"
            >
              {clinics
                .filter((clinic) => !activeOrganizationId || clinic.organizationId === activeOrganizationId)
                .map((clinic) => (
                  <option key={clinic.id} value={clinic.id}>
                    {clinic.name}
                  </option>
                ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#89aa9e]" aria-hidden="true" />
          </label>

          <p className="mt-2 truncate px-1 text-[0.66rem] text-[#89aa9e]">
            {activeClinicName ? `${activeClinicName} workspace` : 'Clinic workspace'}
          </p>
        </div>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-4" aria-label="Primary navigation">
        {sections.map((section) => {
          const sectionItems = visibleNavItems.filter((item) => item.section === section);
          if (sectionItems.length === 0) return null;

          return (
            <div key={section} className="mt-4 first:mt-2">
              <p className="mb-1.5 px-3 text-[0.6rem] font-bold uppercase tracking-[0.17em] text-[#6f9185]">
                {section}
              </p>
              <div className="space-y-1">
                {sectionItems.map((item) => {
                  const Icon = item.icon;
                  const isActive = pathname === item.href;

                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={closeMenu}
                      aria-current={isActive ? 'page' : undefined}
                      className={`group relative flex min-h-11 items-center gap-3 rounded-xl px-3 text-[0.82rem] font-semibold transition-all duration-200 ${
                        isActive
                          ? 'bg-white/[0.11] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08),0_8px_20px_rgba(2,17,12,0.12)]'
                          : 'text-[#a9c1b8] hover:bg-white/[0.055] hover:text-white'
                      }`}
                    >
                      <span
                        className={`absolute left-0 h-5 w-0.5 rounded-r-full bg-[#83c7b2] transition-opacity ${
                          isActive ? 'opacity-100' : 'opacity-0'
                        }`}
                        aria-hidden="true"
                      />
                      <Icon
                        className={`h-[1.05rem] w-[1.05rem] shrink-0 transition-colors ${
                          isActive ? 'text-[#9bd4c2]' : 'text-[#759b8e] group-hover:text-[#9bd4c2]'
                        }`}
                        aria-hidden="true"
                      />
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>

      <div className="border-t border-white/[0.09] p-3">
        <Link
          href="/mfa"
          onClick={closeMenu}
          className="mb-2 flex min-h-10 items-center gap-2.5 rounded-xl px-3 text-xs font-semibold text-[#9ebbb0] transition hover:bg-white/[0.055] hover:text-white"
        >
          <ShieldCheck className="h-4 w-4 text-[#79ad9d]" aria-hidden="true" />
          Account security
        </Link>

        <div className="flex items-center gap-3 rounded-2xl border border-white/[0.08] bg-black/10 p-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-white/[0.1] bg-[#23483c] text-xs font-bold text-[#cce2da]">
            {name?.charAt(0).toUpperCase() ?? 'U'}
          </div>

          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-semibold text-white">{name}</p>
            <p className="mt-0.5 truncate text-[0.65rem] text-[#89aa9e]">{email}</p>
            {role && (
              <p className="mt-1 w-fit rounded-full bg-white/[0.07] px-1.5 py-0.5 text-[0.55rem] font-bold uppercase tracking-[0.1em] text-[#9fc0b4]">
                {role}
              </p>
            )}
          </div>

          <button
            type="button"
            onClick={onLogout}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[#78998d] transition hover:bg-white/[0.07] hover:text-white"
            aria-label="Sign out"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const {
    user,
    role,
    loading,
    logout,
    setScope,
    activeOrganizationId,
    activeClinicId,
    organizations,
    clinics,
    canManageSettings,
    canManageUsers,
    canReadBilling,
    canManageIntegrations,
  } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const mobileNavRef = useRef<HTMLElement>(null);
  const hadMobileMenuOpenRef = useRef(false);

  const closeMobileMenu = useCallback(() => setMobileOpen(false), []);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!mobileOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMobileMenu();
        return;
      }

      if (event.key !== 'Tab') return;

      const nav = mobileNavRef.current;
      if (!nav) return;

      const focusableElements = Array.from(nav.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )).filter(element => element.offsetParent !== null);

      if (focusableElements.length === 0) {
        event.preventDefault();
        nav.focus();
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;

      if (event.shiftKey && (activeElement === firstElement || !nav.contains(activeElement))) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && (activeElement === lastElement || !nav.contains(activeElement))) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeMobileMenu, mobileOpen]);

  useEffect(() => {
    if (mobileOpen) {
      hadMobileMenuOpenRef.current = true;
      return;
    }

    if (hadMobileMenuOpenRef.current) {
      hadMobileMenuOpenRef.current = false;
      menuButtonRef.current?.focus();
    }
  }, [mobileOpen]);

  useEffect(() => {
    const desktopQuery = window.matchMedia('(min-width: 1024px)');
    const closeAtDesktop = () => {
      if (desktopQuery.matches) closeMobileMenu();
    };

    closeAtDesktop();
    desktopQuery.addEventListener('change', closeAtDesktop);
    return () => desktopQuery.removeEventListener('change', closeAtDesktop);
  }, [closeMobileMenu]);

  if (loading || !user) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-canvas px-6">
        <div className="flex flex-col items-center gap-5">
          <BrandMark compact />
          <div className="h-1.5 w-28 overflow-hidden rounded-full bg-[#dce8e3]" aria-label="Loading workspace" role="status">
            <div className="h-full w-1/2 animate-pulse rounded-full bg-brand" />
          </div>
        </div>
      </div>
    );
  }

  const activeOrganizationName = organizations.find(
    (organization) => organization.id === activeOrganizationId
  )?.name;

  return (
    <div className="min-h-dvh bg-canvas">
      <header
        className="fixed inset-x-0 top-0 z-40 flex h-16 items-center justify-between border-b border-white/[0.1] bg-nav px-4 shadow-[0_8px_28px_rgba(10,36,28,0.12)] lg:hidden"
        aria-hidden={mobileOpen ? true : undefined}
        inert={mobileOpen ? true : undefined}
      >
        <button
          ref={menuButtonRef}
          type="button"
          onClick={() => setMobileOpen(true)}
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/[0.1] text-[#b8cec6] transition hover:bg-white/[0.07] hover:text-white"
          aria-label="Open navigation"
          aria-expanded={mobileOpen}
          aria-controls="mobile-dashboard-navigation"
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
        </button>

        <div className="flex min-w-0 items-center gap-2.5">
          <BrandMark compact inverted />
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold text-white">
              {activeOrganizationName ?? 'Maya'}
            </p>
            <p className="truncate text-[0.62rem] text-[#89aa9e]">Clinic intelligence</p>
          </div>
        </div>

        <button
          type="button"
          onClick={logout}
          className="flex h-10 w-10 items-center justify-center rounded-xl text-[#89aa9e] transition hover:bg-white/[0.07] hover:text-white"
          aria-label="Sign out"
        >
          <LogOut className="h-[1.1rem] w-[1.1rem]" aria-hidden="true" />
        </button>
      </header>

      <div
        onClick={closeMobileMenu}
        aria-hidden="true"
        className={`fixed inset-0 z-40 bg-[#071812]/65 backdrop-blur-sm transition-opacity duration-300 lg:hidden ${
          mobileOpen ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />

      <aside
        ref={mobileNavRef}
        id="mobile-dashboard-navigation"
        role="dialog"
        aria-modal="true"
        aria-label="Dashboard navigation"
        aria-hidden={!mobileOpen}
        inert={mobileOpen ? undefined : true}
        tabIndex={-1}
        className={`fixed bottom-0 left-0 top-0 z-50 w-[min(88vw,280px)] border-r border-white/[0.08] bg-nav shadow-[24px_0_70px_rgba(3,20,14,0.34)] transition-transform duration-300 ease-out lg:hidden ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <button
          ref={closeButtonRef}
          type="button"
          onClick={closeMobileMenu}
          className="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-xl text-[#89aa9e] transition hover:bg-white/[0.07] hover:text-white"
          aria-label="Close navigation"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>

        <SidebarContent
          pathname={pathname}
          name={user.name}
          email={user.email}
          role={role}
          activeOrganizationId={activeOrganizationId}
          activeClinicId={activeClinicId}
          organizations={organizations}
          clinics={clinics}
          canManageSettings={canManageSettings}
          canManageUsers={canManageUsers}
          canReadBilling={canReadBilling}
          canManageIntegrations={canManageIntegrations}
          closeMenu={closeMobileMenu}
          onLogout={logout}
          onScopeChange={(organizationId, clinicId) => {
            void setScope(organizationId, clinicId);
            closeMobileMenu();
          }}
        />
      </aside>

      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[280px] border-r border-white/[0.08] bg-nav shadow-[10px_0_40px_rgba(8,35,26,0.08)] lg:block">
        <SidebarContent
          pathname={pathname}
          name={user.name}
          email={user.email}
          role={role}
          activeOrganizationId={activeOrganizationId}
          activeClinicId={activeClinicId}
          organizations={organizations}
          clinics={clinics}
          canManageSettings={canManageSettings}
          canManageUsers={canManageUsers}
          canReadBilling={canReadBilling}
          canManageIntegrations={canManageIntegrations}
          onLogout={logout}
          onScopeChange={(organizationId, clinicId) => {
            void setScope(organizationId, clinicId);
          }}
        />
      </aside>

      <main
        className="min-h-dvh overflow-x-hidden bg-canvas pt-16 lg:ml-[280px] lg:pt-0"
        aria-hidden={mobileOpen ? true : undefined}
        inert={mobileOpen ? true : undefined}
      >
        {children}
      </main>
    </div>
  );
}
