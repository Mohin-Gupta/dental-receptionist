import { Router, Request, Response } from 'express';
import { prisma } from '../../lib/prisma';

const router = Router();

router.get('/dashboard/settings', async (_req: Request, res: Response) => {
  const clinicId = process.env.DEFAULT_CLINIC_ID!;
  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId } });
  if (!clinic) return res.status(404).json({ error: 'Clinic not found' });
  const { googleTokens: _tokens, ...safe } = clinic as typeof clinic & { googleTokens?: string };
  res.json(safe);
});

router.patch('/dashboard/settings', async (req: Request, res: Response) => {
  const clinicId = process.env.DEFAULT_CLINIC_ID!;
  const body = req.body as {
    name?: string;
    timezone?: string;
    doctorName?: string;
    doctorPhone?: string;
    doctorQualification?: string;
    doctorYOE?: string;
    doctorSpecialty?: string;
    clinicAddress?: string;
    clinicEmail?: string;
    clinicWebsite?: string;
    clinicAbout?: string;
    clinicServices?: string[];
    businessHours?: Record<string, { open: string; close: string } | null>;
  };

  const updated = await prisma.clinic.update({
    where: { id: clinicId },
    data: {
      name:                body.name,
      timezone:            body.timezone,
      doctorName:          body.doctorName,
      doctorPhone:         body.doctorPhone,
      doctorQualification: body.doctorQualification,
      doctorYOE:           body.doctorYOE ? parseInt(body.doctorYOE) : undefined,
      doctorSpecialty:     body.doctorSpecialty,
      clinicAddress:       body.clinicAddress,
      clinicEmail:         body.clinicEmail,
      clinicWebsite:       body.clinicWebsite,
      clinicAbout:         body.clinicAbout,
      clinicServices:      body.clinicServices,
      businessHours:       body.businessHours,
    },
  });

  const { googleTokens: _tokens, ...safe } = updated as typeof updated & { googleTokens?: string };
  res.json(safe);
});

export default router;