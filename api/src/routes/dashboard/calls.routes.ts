import { Request, Response } from 'express';
import { prisma } from '../../lib/prisma';
import { getClinicTimezone } from '../../lib/timezone';
import { requirePermission } from '../../auth/middleware';
import { decryptSecret } from '../../auth/secretBox';
import { z } from 'zod';
import { createRouter } from '../../lib/asyncRouter';
import { auditRequired } from '../../auth/audit';

const router = createRouter();

const callsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  direction: z.enum(['inbound', 'outbound']).optional(),
});

router.get('/dashboard/calls', requirePermission('phi:read'), async (req: Request, res: Response) => {
  const organizationId = req.auth!.organizationId;
  const clinicId = req.auth!.clinicId;
  const parsed = callsQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid call query' });
  const { page, limit, direction } = parsed.data;
  const skip = (page - 1) * limit;

  const where = direction
    ? { organizationId, clinicId, direction }
    : { organizationId, clinicId };

  const [calls, total] = await Promise.all([
    prisma.callLog.findMany({
      where,
      include: { patient: true },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.callLog.count({ where }),
  ]);

  const timezone = await getClinicTimezone(clinicId);

  const visibleCalls = calls.map(call => {
    const transcript = call.transcript;
    if (
      transcript &&
      typeof transcript === 'object' &&
      !Array.isArray(transcript) &&
      typeof (transcript as Record<string, unknown>).ciphertext === 'string'
    ) {
      try {
        const plaintext = decryptSecret(
          (transcript as Record<string, unknown>).ciphertext as string,
          `call-log:${organizationId}:${call.vapiCallId}:transcript`
        );
        return { ...call, transcript: JSON.parse(plaintext) };
      } catch {
        // Key rotation mistakes must not expose ciphertext or take down the
        // entire dashboard response. Operators can recover the missing key.
        return { ...call, transcript: { retained: false, reason: 'temporarily_unavailable' } };
      }
    }
    return call;
  });

  await auditRequired(req, 'phi.calls_list_viewed', {
    targetType: 'CallLog',
    metadata: { page, resultCount: visibleCalls.length, direction: direction ?? 'all' },
  });
  res.json({ calls: visibleCalls, total, page, limit, timezone });
});

export default router;
