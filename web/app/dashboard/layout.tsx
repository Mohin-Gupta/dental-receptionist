'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import {
  LayoutDashboard,
  Calendar,
  Users,
  Phone,
  Settings,
  Stethoscope,
  Menu,
  X,
  LogOut,
} from 'lucide-react';

const navItems = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/dashboard/appointments', label: 'Appointments', icon: Calendar },
  { href: '/dashboard/patients', label: 'Patients', icon: Users },
  { href: '/dashboard/calls', label: 'Call Logs', icon: Phone },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings },
];

interface SidebarProps {
  pathname: string;
  name?: string;
  email?: string;
  role?: string | null;
  canManageSettings: boolean;
  closeMenu?: () => void;
  onLogout: () => void;
}

function SidebarContent({
  pathname,
  name,
  email,
  role,
  canManageSettings,
  closeMenu,
  onLogout,
}: SidebarProps) {
  const visibleNavItems = navItems.filter((item) =>
    item.href === '/dashboard/settings'
      ? canManageSettings
      : true
  );

  return (
    <>
      <div className="px-5 py-5 border-b border-gray-800">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
            <Stethoscope className="w-4 h-4 text-white" />
          </div>

          <div>
            <p className="text-sm font-semibold text-white">
              Smile Dental
            </p>
            <p className="text-xs text-gray-400">
              Admin Portal
            </p>
          </div>
        </div>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1">
        {visibleNavItems.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.href;

          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={closeMenu}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                isActive
                  ? 'bg-blue-600 text-white font-medium'
                  : 'text-gray-400 hover:bg-gray-800 hover:text-white'
              }`}
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="px-4 py-4 border-t border-gray-800">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-gray-800 flex items-center justify-center text-xs font-semibold text-gray-300">
            {name?.charAt(0).toUpperCase() ?? 'U'}
          </div>

          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-white truncate">
              {name}
            </p>

            <p className="text-xs text-gray-400 truncate">
              {email}
            </p>

            {role && (
              <p className="text-[11px] text-gray-500 capitalize">
                {role}
              </p>
            )}
          </div>

          <button
            onClick={onLogout}
            className="p-2 text-gray-500 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
            aria-label="Sign out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </>
  );
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { user, role, loading, logout, canManageSettings } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => {
  setMobileOpen(false);
}, [pathname]);

useEffect(() => {
  if (mobileOpen) {
    document.body.style.overflow =
      'hidden';
  } else {
    document.body.style.overflow =
      '';
  }

  return () => {
    document.body.style.overflow =
      '';
  };
}, [mobileOpen]);

  if (loading || !user) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950">
      {/* Mobile Header */}
      <header className="md:hidden fixed top-0 left-0 right-0 h-14 bg-gray-900 border-b border-gray-800 flex items-center justify-between px-4 z-50">
        <button
          onClick={() => setMobileOpen(true)}
          className="text-white"
        >
          <Menu className="w-5 h-5" />
        </button>

        <div className="flex items-center gap-2">
          <Stethoscope className="w-4 h-4 text-blue-500" />
          <span className="text-sm font-semibold text-white">
            Smile Dental
          </span>
        </div>

        <button
          onClick={logout}
          className="text-gray-400 hover:text-white"
          aria-label="Sign out"
        >
          <LogOut className="w-5 h-5" />
        </button>
      </header>

      {/* Mobile Overlay */}
      <div
        onClick={() => setMobileOpen(false)}
        className={`fixed inset-0 bg-black/60 z-40 md:hidden transition-opacity duration-300 ${
          mobileOpen
            ? 'opacity-100 pointer-events-auto'
            : 'opacity-0 pointer-events-none'
        }`}
      />

      {/* Mobile Sidebar */}
      <aside
        className={`fixed top-0 left-0 h-full w-64 bg-gray-900 border-r border-gray-800 z-50 transform transition-transform duration-300 md:hidden ${
          mobileOpen
            ? 'translate-x-0'
            : '-translate-x-full'
        }`}
      >
        <button
          onClick={() => setMobileOpen(false)}
          className="absolute top-4 right-4 text-gray-400 hover:text-white"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="h-full flex flex-col">
          <SidebarContent
            pathname={pathname}
            name={user.name}
            email={user.email}
            role={role}
            canManageSettings={canManageSettings}
            closeMenu={() => setMobileOpen(false)}
            onLogout={logout}
          />
        </div>
      </aside>

      {/* Desktop Sidebar */}
      <aside className="hidden md:flex fixed left-0 top-0 h-screen w-64 bg-gray-900 border-r border-gray-800 flex-col">
        <SidebarContent
          pathname={pathname}
          name={user.name}
          email={user.email}
          role={role}
          canManageSettings={canManageSettings}
          onLogout={logout}
        />
      </aside>

      {/* Main Content */}
      <main className="min-h-screen pt-14 md:pt-0 md:ml-64 overflow-x-hidden">
        {children}
      </main>
    </div>
  );
}
