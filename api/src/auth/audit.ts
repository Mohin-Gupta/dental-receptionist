import type { Request } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import type { RequestMeta } from './types';

export function getRequestMeta(req: Request): RequestMeta {
  return {
    // Express derives this from the configured trusted-proxy hop count. Never
    // parse X-Forwarded-For independently or a direct client can spoof it.
    ipAddress: req.ip,
    userAgent: req.header('user-agent') ?? undefined,
  };
}

export async function auditAction(
  req: Request,
  action: string,
  options: {
    userId?: string | null;
    organizationId?: string | null;
    clinicId?: string | null;
    targetType?: string;
    targetId?: string;
    metadata?: Record<string, unknown>;
  } = {}
): Promise<void> {
  const meta = getRequestMeta(req);
  try {
    await prisma.auditLog.create({
      data: {
        userId: options.userId ?? req.auth?.userId ?? null,
        organizationId: options.organizationId ?? req.auth?.organizationId ?? null,
        clinicId: options.clinicId ?? req.auth?.clinicId ?? null,
        action,
        targetType: options.targetType,
        targetId: options.targetId,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        metadata: options.metadata as Prisma.InputJsonValue | undefined,
      },
    });
  } catch (err: any) {
    console.warn('Audit log failed:', err?.message);
  }
}

/**
 * Records a disclosure that must exist before protected data is returned.
 * PHI endpoints fail closed if the audit store is unavailable instead of
 * serving sensitive data without an access record.
 */
export async function auditRequired(
  req: Request,
  action: string,
  options: {
    targetType?: string;
    targetId?: string;
    metadata?: Record<string, unknown>;
  } = {}
): Promise<void> {
  if (!req.auth) throw new Error('Authenticated audit context is required');
  const meta = getRequestMeta(req);
  await prisma.auditLog.create({
    data: {
      userId: req.auth.userId,
      organizationId: req.auth.organizationId,
      clinicId: req.auth.clinicId,
      action,
      targetType: options.targetType,
      targetId: options.targetId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: options.metadata as Prisma.InputJsonValue | undefined,
    },
  });
}

export async function securityEvent(
  req: Request,
  type: string,
  options: {
    userId?: string | null;
    organizationId?: string | null;
    clinicId?: string | null;
    metadata?: Record<string, unknown>;
  } = {}
): Promise<void> {
  const meta = getRequestMeta(req);
  try {
    await prisma.securityEvent.create({
      data: {
        userId: options.userId ?? null,
        organizationId: options.organizationId ?? req.auth?.organizationId ?? null,
        clinicId: options.clinicId ?? null,
        type,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        metadata: options.metadata as Prisma.InputJsonValue | undefined,
      },
    });
  } catch (err: any) {
    console.warn('Security event failed:', err?.message);
  }
}
