import { z } from 'zod';

/** `POST /api/pokemon/connect/complete`: the address bar after logging in on Pokémon's page (paste-back, §4.2 a). */
export const ConnectCompleteBody = z.object({
  url: z.string().trim().min(1, 'Paste the address from the play-tools tab').max(4096),
});
export type ConnectCompleteBody = z.infer<typeof ConnectCompleteBody>;

/** `PUT /api/settings`. M4: the upstream league; timezone, thresholds and batch delay join later. */
export const SettingsBody = z.object({
  activityGroupId: z.string().trim().min(1).max(100),
});
export type SettingsBody = z.infer<typeof SettingsBody>;
