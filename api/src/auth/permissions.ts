import type { AuthRole, Permission } from './types';

const ROLE_PERMISSIONS: Record<AuthRole, Permission[]> = {
  owner: [
    'dashboard:read',
    'phi:read',
    'appointments:write',
    'settings:read',
    'settings:write',
    'users:manage',
    'integrations:manage',
    'billing:read',
    'billing:write',
  ],
  admin: [
    'dashboard:read',
    'phi:read',
    'appointments:write',
    'settings:read',
    'settings:write',
    'billing:read',
  ],
  staff: ['dashboard:read', 'phi:read', 'appointments:write'],
  viewer: ['dashboard:read'],
};

export function isAuthRole(value: string): value is AuthRole {
  return value === 'owner' || value === 'admin' || value === 'staff' || value === 'viewer';
}

export function hasPermission(role: AuthRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
