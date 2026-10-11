import { z } from '../zod';
import { type PlayerId, toPlayerId } from '../types/ids';

const PLAYER_ID = /^\d{1,12}$/;

/** A player ID typed or pasted by hand: a string, so leading zeros survive. */
export const playerId = z
  .string()
  .trim()
  .regex(PLAYER_ID, 'Player IDs are 1–12 digits')
  .transform((s) => s as PlayerId);

/** Display name; blank means "no name given". */
const optionalName = z
  .string()
  .trim()
  .max(100, 'At most 100 characters')
  .optional()
  .transform((s) => s || undefined);

/** `T` with every key that may be `undefined` made optional. */
type Compact<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/** Drops keys whose value is `undefined`, so parsed bodies compare cleanly. */
const compact = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Compact<T>;

export const PlayerInput = z.object({ playerId, name: optionalName }).transform(compact);
export type PlayerInput = z.infer<typeof PlayerInput>;

export const PlayerIdParam = z.object({ playerId });

/** Upper bound for one `regulars.json` import (same cap as a TDF, architecture §9). */
export const REGULARS_IMPORT_MAX = 2000;

/** The CLI's `regulars.json`: `[{ name, player_id }]`. Hand-edited files may carry numeric IDs. */
export const RegularsImportBody = z
  .array(
    z
      .object({
        player_id: z.union([playerId, z.number().int().nonnegative().transform(toPlayerId)]),
        name: optionalName,
      })
      .transform(({ player_id, name }) => compact({ playerId: player_id, name })),
  )
  .min(1, 'The file has no players')
  .max(REGULARS_IMPORT_MAX, `At most ${REGULARS_IMPORT_MAX} players per import`);
export type RegularsImportBody = z.infer<typeof RegularsImportBody>;

export const PlayerPatch = z
  .object({
    name: z.string().trim().min(1, 'Enter a name').max(100, 'At most 100 characters').optional(),
    notes: z
      .string()
      .trim()
      .max(500, 'At most 500 characters')
      .nullable()
      .optional()
      .transform((s) => (s === '' ? null : s)),
    isRegular: z.boolean().optional(),
  })
  .transform(compact)
  .refine((p) => Object.keys(p).length > 0, 'Nothing to change');
export type PlayerPatch = z.infer<typeof PlayerPatch>;

export const PLAYERS_LIMIT_MAX = 100;

/** The Players page tabs: promotion candidates, stale regulars, everyone (architecture §8). */
export const PlayersQuery = z
  .object({
    filter: z.enum(['all', 'promote', 'stale']).default('all'),
    q: z
      .string()
      .trim()
      .max(100)
      .optional()
      .transform((s) => s || undefined),
    /** Caps the result, e.g. for search-as-you-type; absent means every match. */
    limit: z
      .string()
      .regex(/^\d+$/, 'Use a whole number')
      .transform(Number)
      .pipe(z.number().int().min(1).max(PLAYERS_LIMIT_MAX))
      .optional(),
  })
  .transform(compact);
export type PlayersQuery = z.infer<typeof PlayersQuery>;
