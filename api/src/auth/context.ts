import { prisma } from '../lib/prisma';
import { isAuthRole } from './permissions';
import type { AuthClinicAccess, AuthContext, AuthMembership, AuthOrganizationAccess, AuthRole } from './types';

const ROLE_RANK: Record<AuthRole, number> = {
  viewer: 1,
  staff: 2,
  admin: 3,
  owner: 4,
};

export class AuthSelectionError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export function strongestRole(...roles: Array<AuthRole | null | undefined>): AuthRole | null {
  return roles.reduce<AuthRole | null>((best, role) => {
    if (!role) return best;
    if (!best || ROLE_RANK[role] > ROLE_RANK[best]) return role;
    return best;
  }, null);
}

export function resolveEffectiveRole(
  organizationRole: AuthRole | null | undefined,
  clinicRole: AuthRole | null | undefined
): AuthRole | null {
  if (organizationRole === 'owner') return 'owner';
  return clinicRole ?? organizationRole ?? null;
}

function setOrganization(
  map: Map<string, AuthOrganizationAccess>,
  organization: { id: string; name: string },
  role: AuthRole | null
) {
  const existing = map.get(organization.id);
  map.set(organization.id, {
    id: organization.id,
    name: organization.name,
    role: strongestRole(existing?.role, role),
  });
}

function setClinic(
  map: Map<string, AuthClinicAccess>,
  clinic: { id: string; organizationId: string; name: string }
) {
  if (map.has(clinic.id)) return;

  map.set(clinic.id, {
    id: clinic.id,
    organizationId: clinic.organizationId,
    name: clinic.name,
    role: null,
  });
}

export async function buildAuthContextForUser(
  userId: string,
  sessionId: string,
  requestedOrganizationId?: string,
  requestedClinicId?: string
): Promise<AuthContext> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      organizationMemberships: {
        include: {
          organization: {
            include: {
              clinics: { where: { status: 'active' }, orderBy: { createdAt: 'asc' } },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      },
      memberships: {
        where: { clinic: { status: 'active' } },
        include: {
          clinic: { include: { organization: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  if (!user || user.status !== 'active') {
    throw new AuthSelectionError(401, 'Authentication required');
  }

  const organizationRoleById = new Map<string, AuthRole>();
  const clinicRoleById = new Map<string, AuthRole>();
  const organizationsById = new Map<string, AuthOrganizationAccess>();
  const clinicsById = new Map<string, AuthClinicAccess>();

  for (const membership of user.organizationMemberships) {
    if (!isAuthRole(membership.role)) continue;

    const role = membership.role;
    organizationRoleById.set(membership.organizationId, role);
    setOrganization(organizationsById, membership.organization, role);

    for (const clinic of membership.organization.clinics) {
      setClinic(clinicsById, clinic);
    }
  }

  for (const membership of user.memberships) {
    if (!isAuthRole(membership.role)) continue;

    const role = membership.role;
    clinicRoleById.set(membership.clinicId, role);
    setOrganization(organizationsById, membership.clinic.organization, null);
    setClinic(clinicsById, membership.clinic);
  }

  const organizations = Array.from(organizationsById.values());
  const clinics = Array.from(clinicsById.values()).map((clinic) => ({
    ...clinic,
    role: resolveEffectiveRole(
      organizationRoleById.get(clinic.organizationId),
      clinicRoleById.get(clinic.id)
    ),
  }));
  const effectiveClinicsById = new Map(clinics.map((clinic) => [clinic.id, clinic]));

  if (organizations.length === 0 || clinics.length === 0) {
    throw new AuthSelectionError(403, 'No clinic access');
  }

  const selectedOrganization = requestedOrganizationId
    ? organizationsById.get(requestedOrganizationId)
    : organizations[0];

  if (!selectedOrganization) {
    throw new AuthSelectionError(403, 'Organization access denied');
  }

  const clinicsInOrganization = clinics.filter((clinic) => clinic.organizationId === selectedOrganization.id);
  const selectedClinic = requestedClinicId
    ? effectiveClinicsById.get(requestedClinicId)
    : clinicsInOrganization[0];

  if (!selectedClinic || selectedClinic.organizationId !== selectedOrganization.id) {
    throw new AuthSelectionError(403, 'Clinic access denied');
  }

  const organizationRole = organizationRoleById.get(selectedOrganization.id) ?? null;
  const clinicRole = clinicRoleById.get(selectedClinic.id) ?? null;
  const effectiveRole = resolveEffectiveRole(organizationRole, clinicRole);

  if (!effectiveRole) {
    throw new AuthSelectionError(403, 'Permission denied');
  }

  const memberships: AuthMembership[] = clinics.map((clinic) => ({
    clinicId: clinic.id,
    role: clinic.role ?? 'viewer',
  }));

  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    organizationId: selectedOrganization.id,
    clinicId: selectedClinic.id,
    role: effectiveRole,
    organizationRole,
    clinicRole,
    memberships,
    organizations,
    clinics,
    sessionId,
  };
}
