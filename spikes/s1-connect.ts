/**
 * Spike S1 (+ first half of S5): can a PKCE code issued for OUR verifier be
 * pasted back from play-tools.pokemon.com/loggedIn and redeemed?
 *
 *   pnpm spike:s1              start a new attempt and wait for the paste
 *   pnpm spike:s1 resume       resume a pending attempt (≤ 10 min old)
 *
 * See spikes/README.md for the two capture modes to try.
 */
import { decodeJwtPayload } from '../server/modules/pokemon/adapters/ptc-oauth/wire';
import { buildAuthorizeUrl, createPkcePair, createState, parseCallbackUrl } from '../server/modules/pokemon/adapters/ptc-oauth/pkce';
import { fail, heading, prompt, run } from './lib/cli';
import { SECRETS_DIR, fingerprint, paths, readSecretJson, writeSecretJson } from './lib/secrets';
import { OAuthError, claimShape, claimsOf, exchangeCode } from './lib/tokens';
import { join } from 'node:path';

interface PendingAuth {
  verifier: string;
  state: string;
  created_at: string;
}

const PENDING_TTL_MS = 10 * 60_000;

run(async () => {
  const resume = process.argv[2] === 'resume';
  let pending = resume ? readSecretJson<PendingAuth>(paths.pendingAuth) : undefined;
  if (resume && !pending) fail('No pending attempt. Run `pnpm spike:s1` without arguments.');

  if (!pending) {
    const { verifier, challenge } = createPkcePair();
    pending = { verifier, state: createState(), created_at: new Date().toISOString() };
    writeSecretJson(paths.pendingAuth, pending);
    heading('S1 · open this URL in the browser where you use play-tools');
    console.log(buildAuthorizeUrl(challenge, pending.state).toString());
    console.log(`
Log in on Pokémon's page. You will be redirected to
https://play-tools.pokemon.com/loggedIn?code=…&state=…
Copy the FULL address-bar URL and paste it below.
(Capture modes: see spikes/README.md · S1.)`);
  }

  if (Date.now() - Date.parse(pending.created_at) > PENDING_TTL_MS) {
    fail('Pending attempt is older than 10 minutes. Start a new one.');
  }

  const mode = (await prompt('Capture mode used? [l]oaded normally / [b]locked play-tools: ')).startsWith('b') ? 'blocked' : 'loaded';
  const pasted = await prompt('Paste the redirected URL: ');
  const parsed = parseCallbackUrl(pasted);
  if (!parsed.ok) fail(parsed.error);
  if (parsed.state !== pending.state) fail('state mismatch: this URL belongs to a different login attempt.');

  const pastedAfterMs = Date.now() - Date.parse(pending.created_at);
  const result: Record<string, unknown> = { at: new Date().toISOString(), mode, pasted_after_s: Math.round(pastedAfterMs / 1000) };

  try {
    const { raw, stored } = await exchangeCode(parsed.code, pending.verifier);
    const access = claimsOf(stored.access_token);
    Object.assign(result, {
      exchange: 'ok',
      token_type: raw.token_type,
      expires_in: raw.expires_in,
      scope: raw.scope,
      response_fields: Object.keys(raw),
      refresh_token_present: Boolean(raw.refresh_token),
      refresh_token_prefix: raw.refresh_token?.slice(0, 7),
      refresh_token_fp: fingerprint(stored.refresh_token),
      access_token_format: access ? 'jwt' : `opaque (${stored.access_token.slice(0, 7)}…)`,
      access_token_claim_shape: access ? claimShape(decodeJwtPayload(stored.access_token)) : null,
      access_token_sub: access?.claims.sub,
      access_token_aud: access?.claims.aud,
      access_token_iss: access?.claims.iss,
      access_token_exp: access?.expIso,
      id_token_claim_shape: raw.id_token ? claimShape(decodeJwtPayload(raw.id_token)) : null,
      id_token_sub: raw.id_token ? (decodeJwtPayload(raw.id_token) as { sub?: string }).sub : undefined,
    });
    heading('S1 · SUCCESS: code redeemed with our verifier');
  } catch (err) {
    if (!(err instanceof OAuthError)) throw err;
    Object.assign(result, { exchange: 'failed', status: err.status, error: err.error, error_description: err.description });
    heading('S1 · exchange FAILED');
    if (mode === 'loaded') console.log('Likely the play-tools SPA consumed the code first. Retry with the "blocked" capture mode.');
  }

  const file = join(SECRETS_DIR, `s1-result.${mode}.json`);
  writeSecretJson(file, result);
  console.log(JSON.stringify(result, null, 2));
  console.log(`\nSaved (no secrets) to ${file}. Copy the relevant lines into docs/architecture/spikes.md.`);
});
