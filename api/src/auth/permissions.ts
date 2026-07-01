import type { AuthRole, Permission } from './types';

const ROLE_PERMISSIONS: Record<AuthRole, Permission[]> = {
  owner: [
    'dashboard:read',
    'appointments:write',
    'settings:read',
    'settings:write',
    'users:manage',
    'integrations:manage',
  ],
  admin: ['dashboard:read', 'appointments:write', 'settings:read', 'settings:write'],
  staff: ['dashboard:read', 'appointments:write'],
  viewer: ['dashboard:read'],
};

export function isAuthRole(value: string): value is AuthRole {
  return value === 'owner' || value === 'admin' || value === 'staff' || value === 'viewer';
}

export function hasPermission(role: AuthRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
