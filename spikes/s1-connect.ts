/**
 * Spike S1 (+ first half of S5): can a PKCE code issued for OUR verifier be
 * pasted back from play-tools.pokemon.com/loggedIn and redeemed?
 *
 *   pnpm spike:s1 [--mode loaded|blocked] [--no-wait]
 *       start an attempt, print its authorize URL, then wait for the paste
 *       (--no-wait: print and exit; several attempts may be pending at once)
 *   pnpm spike:s1 resume [<redirected URL>]
 *       redeem a pasted URL; the attempt (and its mode) is found by `state`
 *
 * See spikes/README.md for the two capture modes.
 */
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { buildAuthorizeUrl, createPkcePair, createState, parseCallbackUrl } from '../server/modules/pokemon/adapters/ptc-oauth/pkce';
import { decodeJwtPayload } from '../server/modules/pokemon/adapters/ptc-oauth/wire';
import { fail, heading, prompt, run } from './lib/cli';
import { SECRETS_DIR, fingerprint, paths, readSecretJson, writeSecretJson } from './lib/secrets';
import { OAuthError, claimShape, claimsOf, exchangeCode } from './lib/tokens';

type Mode = 'loaded' | 'blocked';

interface PendingAuth {
  verifier: string;
  mode: Mode;
  created_at: string;
}

/** Our own bookkeeping limit. Hydra's code lifetime (what S1 measures) starts at the redirect, not here. */
const PENDING_TTL_MS = 24 * 3_600_000;

run(async () => {
  const { values: args, positionals } = parseArgs({
    allowPositionals: true,
    options: { mode: { type: 'string', default: 'loaded' }, 'no-wait': { type: 'boolean', default: false } },
  });

  if (positionals[0] !== 'resume') {
    if (args.mode !== 'loaded' && args.mode !== 'blocked') fail('--mode must be loaded or blocked');
    const { verifier, challenge } = createPkcePair();
    const state = createState();
    savePending(state, { verifier, mode: args.mode, created_at: new Date().toISOString() });
    heading(`S1 · ${args.mode} mode · open this URL in the browser where you use play-tools`);
    console.log(buildAuthorizeUrl(challenge, state).toString());
    console.log(`\nLog in on Pokémon's page, then copy the FULL https://play-tools.pokemon.com/loggedIn?code=…&state=… URL.`);
    if (args['no-wait']) return;
  }

  const pasted = positionals[1] ?? (await prompt('Paste the redirected URL: '));
  const parsed = parseCallbackUrl(pasted);
  if (!parsed.ok) fail(parsed.error);
  const pending = takePending(parsed.state);
  if (!pending) fail('No pending attempt matches this URL’s state (already used, expired, or from another run).');

  const result: Record<string, unknown> = {
    at: new Date().toISOString(),
    mode: pending.mode,
    since_attempt_created_s: Math.round((Date.now() - Date.parse(pending.created_at)) / 1000),
  };

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
    if (pending.mode === 'loaded') console.log('Likely the play-tools SPA consumed the code first. Retry with --mode blocked.');
  }

  const file = join(SECRETS_DIR, `s1-result.${pending.mode}.json`);
  writeSecretJson(file, result);
  console.log(JSON.stringify(result, null, 2));
  console.log(`\nSaved (no secrets) to ${file}.`);
});

function loadAll(): Record<string, PendingAuth> {
  const all = readSecretJson<Record<string, PendingAuth>>(paths.pendingAuth) ?? {};
  const now = Date.now();
  return Object.fromEntries(Object.entries(all).filter(([, p]) => now - Date.parse(p.created_at) < PENDING_TTL_MS));
}

function savePending(state: string, p: PendingAuth): void {
  writeSecretJson(paths.pendingAuth, { ...loadAll(), [state]: p });
}

/** Single use: the attempt is removed whether or not the exchange succeeds. */
function takePending(state: string): PendingAuth | undefined {
  const all = loadAll();
  const p = all[state];
  delete all[state];
  writeSecretJson(paths.pendingAuth, all);
  return p;
}
