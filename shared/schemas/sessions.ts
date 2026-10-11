import { z } from 'zod';
import type { SessionDate } from '../types/ids';
import { playerId } from './roster';

/** `YYYY-MM-DD` that is a real calendar date (no Feb 30). */
export const sessionDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
  }, 'Not a calendar date')
  .transform((s) => s as SessionDate);

export const SessionDateParam = z.object({ date: sessionDate });

export const SessionPlayerParams = z.object({ date: sessionDate, playerId });
