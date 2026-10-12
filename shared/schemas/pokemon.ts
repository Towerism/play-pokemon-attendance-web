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

/** `GET /api/leagues/upstream?professor=…`: whose leagues to list. */
export const ProfessorQuery = z.object({ professor: ProfessorPlayerId });
