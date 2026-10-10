import { PTC_OAUTH } from '../../server/modules/pokemon/adapters/ptc-oauth/constants';
import {
  AccessTokenClaims,
  OAuthErrorResponse,
  TokenResponse,
  decodeJwtPayload,
} from '../../server/modules/pokemon/adapters/ptc-oauth/wire';
import { withFileLock } from './lock';
import { appendSecretJsonl, fingerprint, paths, readSecretJson, writeSecretJson } from './secrets';

export interface StoredTokens {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  scope?: string;
  obtained_at: string;
  expires_at: string;
  /** Kept only so S2 `--probe-reuse` can test Hydra's reuse detection. */
  previous_refresh_token?: string;
}

export class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly description?: string,
  ) {
    super(`${status} ${error}${description ? `: ${description}` : ''}`);
  }
}

async function tokenRequest(form: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(PTC_OAUTH.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form),
  });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = OAuthErrorResponse.safeParse(body);
    throw new OAuthError(res.status, e.success ? e.data.error : 'unknown_error', e.success ? e.data.error_description : JSON.stringify(body));
  }
  return TokenResponse.parse(body);
}

function toStored(t: TokenResponse, previous?: StoredTokens): StoredTokens {
  const refresh = t.refresh_token ?? previous?.refresh_token;
  if (!refresh) throw new Error('Token response carried no refresh_token. Was the `offline` scope granted?');
  const now = Date.now();
  return {
    access_token: t.access_token,
    refresh_token: refresh,
    id_token: t.id_token ?? previous?.id_token,
    scope: t.scope,
    obtained_at: new Date(now).toISOString(),
    expires_at: new Date(now + t.expires_in * 1000).toISOString(),
    previous_refresh_token: t.refresh_token && previous ? previous.refresh_token : previous?.previous_refresh_token,
  };
}

export async function exchangeCode(code: string, verifier: string): Promise<{ raw: TokenResponse; stored: StoredTokens }> {
  const raw = await tokenRequest({
    grant_type: 'authorization_code',
    client_id: PTC_OAUTH.clientId,
    code,
    code_verifier: verifier,
    redirect_uri: PTC_OAUTH.redirectUri,
  });
  const stored = toStored(raw);
  writeSecretJson(paths.tokens, stored);
  return { raw, stored };
}

export function loadTokens(): StoredTokens {
  const t = readSecretJson<StoredTokens>(paths.tokens);
  if (!t) throw new Error('No tokens yet. Run `pnpm spike:s1` first.');
  return t;
}

export interface RefreshOutcome {
  at: string;
  ok: boolean;
  trigger: string;
  rotated?: boolean;
  old_fp: string;
  new_fp?: string;
  expires_in?: number;
  access_exp?: string;
  error?: string;
  error_description?: string;
}

export interface RefreshOptions {
  /** Refresh only if the access token has < 2 min left once the lock is held (another process may have just refreshed). */
  onlyIfExpiring?: boolean;
  /** Use these tokens instead of the file. Only for S2 `probe-reuse`. */
  override?: StoredTokens;
}

const MIN_VALIDITY_MS = 120_000;

/**
 * Refresh grant, serialised across processes by a lock file. Tokens are
 * re-read from disk inside the lock so a caller can never replay a refresh
 * token another process already rotated. The rotated refresh token is written
 * to disk *before* this returns (ADR-0003). Every attempt is appended to the
 * S2 ledger.
 */
export async function refreshTokens(trigger: string, opts: RefreshOptions = {}): Promise<StoredTokens> {
  return withFileLock(paths.refreshLock, async () => {
    const current = opts.override ?? loadTokens();
    if (opts.onlyIfExpiring && Date.parse(current.expires_at) - Date.now() > MIN_VALIDITY_MS) return current;
    return refreshUnlocked(trigger, current);
  });
}

async function refreshUnlocked(trigger: string, current: StoredTokens): Promise<StoredTokens> {
  const outcome: RefreshOutcome = { at: new Date().toISOString(), ok: false, trigger, old_fp: fingerprint(current.refresh_token) };
  try {
    const raw = await tokenRequest({
      grant_type: 'refresh_token',
      client_id: PTC_OAUTH.clientId,
      refresh_token: current.refresh_token,
    });
    const stored = toStored(raw, current);
    writeSecretJson(paths.tokens, stored);
    Object.assign(outcome, {
      ok: true,
      rotated: raw.refresh_token !== undefined && raw.refresh_token !== current.refresh_token,
      new_fp: fingerprint(stored.refresh_token),
      expires_in: raw.expires_in,
      access_exp: claimsOf(stored.access_token)?.expIso,
    });
    return stored;
  } catch (err) {
    if (err instanceof OAuthError) Object.assign(outcome, { error: err.error, error_description: err.description });
    else outcome.error = String(err);
    throw err;
  } finally {
    appendSecretJsonl(paths.refreshLedger, outcome);
  }
}

/** Access token with ≥ 2 min validity, refreshing if needed (the TokenProvider contract). */
export async function getAccessToken(): Promise<StoredTokens> {
  const t = loadTokens();
  if (Date.parse(t.expires_at) - Date.now() > MIN_VALIDITY_MS) return t;
  return refreshTokens('auto', { onlyIfExpiring: true });
}

/** Claims of a JWT access token, or `undefined` if Hydra issued an opaque (`ory_at_…`) token. */
export function claimsOf(token: string): { claims: AccessTokenClaims; expIso: string } | undefined {
  let payload: unknown;
  try {
    payload = decodeJwtPayload(token);
  } catch {
    return undefined;
  }
  const claims = AccessTokenClaims.parse(payload);
  return { claims, expIso: new Date(claims.exp * 1000).toISOString() };
}

/** Claim names and value types only, never values, for recording in findings. */
export function claimShape(payload: unknown): Record<string, string> {
  if (!payload || typeof payload !== 'object') return {};
  return Object.fromEntries(
    Object.entries(payload).map(([k, v]) => [k, Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v]),
  );
}
