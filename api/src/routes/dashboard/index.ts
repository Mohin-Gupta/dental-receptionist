import { Router } from 'express';
import statsRoutes from './stats.routes';
import appointmentsRoutes from './appointments.routes';
import availableSlotsRoutes from './availableSlots.routes';
import patientsRoutes from './patients.routes';
import callsRoutes from './calls.routes';
import settingsRoutes from './settings.routes';
import remindersRoutes from './reminders.routes';
import { requireAuth, requireClinic, requireCsrf } from '../../auth/middleware';

/**
 * dashboard/index.ts — combines every dashboard sub-router into one router,
 * mounted exactly the same way the old monolithic dashboard.ts was
 * (`app.use('/api', dashboardRoutes)` in index.ts — no change needed there).
 *
 * Each sub-router still defines its own full path (e.g. '/dashboard/stats'),
 * so this file is purely composition — no route paths changed, no behavior
 * changed, just where the code physically lives.
 */
const router = Router();

router.use('/dashboard', requireAuth, requireClinic, requireCsrf);

router.use(statsRoutes);
router.use(appointmentsRoutes);
router.use(availableSlotsRoutes);
router.use(patientsRoutes);
router.use(callsRoutes);
router.use(settingsRoutes);
router.use(remindersRoutes);

export default router;
