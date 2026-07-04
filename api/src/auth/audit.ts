import type { Request } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import type { RequestMeta } from './types';

export function getRequestMeta(req: Request): RequestMeta {
  const forwardedFor = req.header('x-forwarded-for')?.split(',')[0]?.trim();
  return {
    ipAddress: forwardedFor || req.ip,
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
