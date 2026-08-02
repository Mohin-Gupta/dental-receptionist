import { z } from 'zod';

export const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type DayName = (typeof DAY_NAMES)[number];

/** Matches DoctorAvailability.dayOfWeek / JS Date#getUTCDay(): 0 = Sunday. */
export function dayNameToIndex(day: DayName): number {
  return DAY_NAMES.indexOf(day);
}

export function dayIndexToName(index: number): DayName {
  return DAY_NAMES[index];
}

export const timeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Time must use HH:MM format');

export const openingHoursSchema = z
  .object({ open: timeSchema, close: timeSchema })
  .strict()
  .nullable();

/**
 * A week of hours, e.g. { mon: {open,close}, tue: null, ... }. Every key is
 * optional on the wire (a day can be omitted), but callers that treat this
 * as a full replace (clinic business hours, doctor availability overrides)
 * interpret an omitted day the same as an explicit null.
 */
export const weeklyHoursSchema = z
  .object({
    sun: openingHoursSchema.optional(),
    mon: openingHoursSchema.optional(),
    tue: openingHoursSchema.optional(),
    wed: openingHoursSchema.optional(),
    thu: openingHoursSchema.optional(),
    fri: openingHoursSchema.optional(),
    sat: openingHoursSchema.optional(),
  })
  .strict();

export type WeeklyHours = z.infer<typeof weeklyHoursSchema>;
