import { z } from '../zod';

/** `POST /api/pokemon/connect/complete`: the address bar after logging in on Pokémon's page (paste-back, §4.2 a). */
export const ConnectCompleteBody = z.object({
  url: z.string().trim().min(1, 'Paste the address from the play-tools tab').max(4096),
});
export type ConnectCompleteBody = z.infer<typeof ConnectCompleteBody>;

/** A professor's player id: 1–12 digits, kept as text so leading zeros survive. */
export const ProfessorPlayerId = z.string().regex(/^\d{1,12}$/, 'A player id is 1–12 digits');

/** `DELETE /api/pokemon/connections/:playerId`. */
export const ProfessorParams = z.object({ playerId: ProfessorPlayerId });

/**
 * `PATCH /api/pokemon/connections/:playerId`: the professor's display name (ADR-0008) and full name (ADR-0011
 * decision 8). Either or both; a field left out stays as it is. The display name is display only, never sent to
 * Pokémon, at most 60 characters. Both are trimmed, with no control characters. An empty value or null clears it.
 */
const optionalName = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `At most ${max} characters`)
    .regex(/^[^\p{Cc}]*$/u, 'No control characters')
    .nullable()
    .transform((n) => n || null)
    .optional();

export const ProfessorNamesBody = z
  .object({
    name: optionalName(60),
    /**
     * The professor's full name as play-tools has it (ADR-0011 decision 8): written into a TDF only when the app
     * replaces the file's organizer. At most 100 characters.
     */
    fullName: optionalName(100),
  })
  .refine((b) => b.name !== undefined || b.fullName !== undefined, 'Send a name, a full name, or both');
export type ProfessorNamesBody = z.infer<typeof ProfessorNamesBody>;

/** `GET /api/leagues/upstream?professor=…`: whose leagues to list. */
export const ProfessorQuery = z.object({ professor: ProfessorPlayerId });
