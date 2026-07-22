export type AuthRole = 'owner' | 'admin' | 'staff' | 'viewer';

export type Permission =
  | 'dashboard:read'
  | 'phi:read'
  | 'appointments:write'
  | 'settings:read'
  | 'settings:write'
  | 'users:manage'
  | 'integrations:manage'
  | 'billing:read'
  | 'billing:write';

export interface AuthMembership {
  clinicId: string;
  role: AuthRole;
}

export interface AuthOrganizationAccess {
  id: string;
  name: string;
  role: AuthRole | null;
}

export interface AuthClinicAccess {
  id: string;
  organizationId: string;
  name: string;
  role: AuthRole | null;
}

export interface AuthContext {
  userId: string;
  email: string;
  name: string;
  organizationId: string;
  role: AuthRole;
  organizationRole: AuthRole | null;
  clinicRole: AuthRole | null;
  clinicId: string;
  memberships: AuthMembership[];
  organizations: AuthOrganizationAccess[];
  clinics: AuthClinicAccess[];
  sessionId: string;
}

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
}
