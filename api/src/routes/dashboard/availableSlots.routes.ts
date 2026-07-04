import { Router, Request, Response } from 'express';
import { getAvailableSlots } from '../../services/googleCalendar';
import { requirePermission } from '../../auth/middleware';
import { resolveDoctorForClinic } from '../../services/doctors';

const router = Router();

// Used by the admin "New Appointment" modal to show bookable times for a given
// date. Reuses the exact same getAvailableSlots logic Maya uses on calls —
// same business hours, same Google Calendar freebusy check, same 30-min slot grid.
router.get('/dashboard/available-slots', requirePermission('appointments:write'), async (req: Request, res: Response) => {
  const organizationId = req.auth!.organizationId;
  const clinicId = req.auth!.clinicId;
  const { date, doctorId } = req.query as { date?: string; doctorId?: string };

  if (!date) {
    return res.status(400).json({ error: 'date query param is required (YYYY-MM-DD)' });
  }

  try {
    const doctor = await resolveDoctorForClinic(organizationId, clinicId, doctorId);
    const slots = await getAvailableSlots(clinicId, date, doctor.id);
    slots.sort((a, b) => {
      const [aH, aM] = a.start.split(':').map(Number);
      const [bH, bM] = b.start.split(':').map(Number);
      return (aH * 60 + aM) - (bH * 60 + bM);
    });
    res.json({ date, doctorId: doctor.id, slots });
  } catch (err: any) {
    console.error('Available slots fetch failed:', err?.message);
    res.status(500).json({ error: 'Failed to fetch available slots' });
  }
});

export default router;
