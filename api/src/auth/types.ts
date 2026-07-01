export type AuthRole = 'owner' | 'admin' | 'staff' | 'viewer';

export type Permission =
  | 'dashboard:read'
  | 'appointments:write'
  | 'settings:read'
  | 'settings:write'
  | 'users:manage'
  | 'integrations:manage';

export interface AuthMembership {
  clinicId: string;
  role: AuthRole;
}

export interface AuthContext {
  userId: string;
  email: string;
  name: string;
  role: AuthRole;
  clinicId: string;
  memberships: AuthMembership[];
  sessionId: string;
}

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
}
