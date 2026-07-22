import { z } from 'zod';

const dateSchema = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/);
const doctorIdSchema = z.preprocess(
  value => (value === '' || value === null ? undefined : value),
  z.string().uuid().optional()
);

export const VAPI_TOOL_PARAMETER_SCHEMAS: Record<string, z.ZodTypeAny> = {
  checkAvailability: z.object({ date: dateSchema, doctorId: doctorIdSchema }).strict(),
  validateSlot: z.object({
    date: dateSchema,
    time: z.string().trim().min(1).max(20),
    doctorId: doctorIdSchema,
  }).strict(),
  storeName: z.object({ letters: z.string().trim().min(1).max(200) }).strict(),
  confirmDetails: z.object({
    date: dateSchema,
    time: z.string().trim().min(1).max(20),
    reason: z.string().trim().min(1).max(500).optional(),
    patientName: z.string().trim().min(1).max(120).optional(),
    patientPhone: z.string().trim().min(4).max(30).optional(),
  }).strict(),
  requestCallerVerification: z.object({
    patientName: z.string().trim().min(2).max(120),
  }).strict(),
  verifyCallerCode: z.object({
    code: z.string().trim().regex(/^\d{6}$/),
  }).strict(),
  findAppointment: z.object({ patientName: z.string().trim().min(2).max(120) }).strict(),
  cancelAppointment: z.object({ appointmentId: z.string().trim().uuid() }).strict(),
  rescheduleAppointment: z.object({
    appointmentId: z.string().trim().uuid(),
    newDate: dateSchema,
    newTime: z.string().trim().min(1).max(20),
    doctorId: doctorIdSchema,
  }).strict(),
  bookAppointment: z.object({ doctorId: doctorIdSchema }).strict(),
};
