/** Test-only helpers for the pokemon module. Not imported by production code. */

/** An unsigned JWT with the claims Hydra puts in a play-tools access token (S1). */
export function fakeAccessToken(claims: { sub: string; exp: number; jti?: string }): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ aud: ['https://op-core.pokemon.com'], client_id: 'op-tools-app', ...claims })}.sig`;
}
