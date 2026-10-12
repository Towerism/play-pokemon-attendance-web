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
 * `PATCH /api/pokemon/connections/:playerId`: the professor's display name (ADR-0008). Display only, never sent to
 * Pokémon; trimmed, at most 60 characters, no control characters. An empty name or null clears it.
 */
export const ProfessorNameBody = z.object({
  name: z
    .string()
    .trim()
    .max(60, 'At most 60 characters')
    .regex(/^[^\p{Cc}]*$/u, 'No control characters')
    .nullable()
    .transform((n) => n || null),
});
export type ProfessorNameBody = z.infer<typeof ProfessorNameBody>;

/** `GET /api/leagues/upstream?professor=…`: whose leagues to list. */
export const ProfessorQuery = z.object({ professor: ProfessorPlayerId });
