import { z } from 'zod';

/**
 * Hydra /oauth2/token responses. Standard OAuth 2.0 shapes; S1/S2 confirm
 * which optional fields are actually present.
 */
export const TokenResponse = z.looseObject({
  access_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.number().int().positive(),
  scope: z.string().optional(),
  /** Present when `offline` scope is granted. Hydra rotates it on every refresh (S2 verifies). */
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().optional(),
});
export type TokenResponse = z.infer<typeof TokenResponse>;

export const OAuthErrorResponse = z.looseObject({
  error: z.string(),
  error_description: z.string().optional(),
});

/** Claims the adapter relies on in the access-token JWT. TODO(S5): add the OP user-id claim if it isn't `sub`. */
export const AccessTokenClaims = z.looseObject({
  sub: z.string().min(1),
  exp: z.number().int(),
  iss: z.string().optional(),
  aud: z.union([z.string(), z.array(z.string())]).optional(),
  scp: z.union([z.string(), z.array(z.string())]).optional(),
});
export type AccessTokenClaims = z.infer<typeof AccessTokenClaims>;

/** Decodes a JWT payload without verifying it. Only for reading our own token's claims. */
export function decodeJwtPayload(jwt: string): unknown {
  const parts = jwt.split('.');
  if (parts.length !== 3 || !parts[1]) throw new TypeError('Not a JWT');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
}
