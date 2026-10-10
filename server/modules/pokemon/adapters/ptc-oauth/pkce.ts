import { createHash, randomBytes } from 'node:crypto';
import { PTC_OAUTH } from './constants';

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** RFC 7636 S256 challenge for a verifier. */
export function s256Challenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: s256Challenge(verifier) };
}

export function createState(): string {
  return randomBytes(16).toString('base64url');
}

export function buildAuthorizeUrl(challenge: string, state: string): URL {
  const url = new URL(PTC_OAUTH.authorizeEndpoint);
  url.search = new URLSearchParams({
    client_id: PTC_OAUTH.clientId,
    response_type: 'code',
    scope: PTC_OAUTH.scope,
    audience: PTC_OAUTH.audience,
    redirect_uri: PTC_OAUTH.redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return url;
}

export type CallbackParseResult =
  | { ok: true; code: string; state: string }
  | { ok: false; error: string };

/**
 * Parses what the organizer pastes back after logging in: the full
 * `https://play-tools.pokemon.com/loggedIn?code=…&state=…` URL.
 */
export function parseCallbackUrl(input: string): CallbackParseResult {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, error: 'Not a URL. Paste the whole address bar contents.' };
  }
  const expected = new URL(PTC_OAUTH.redirectUri);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
    return { ok: false, error: `Expected a ${PTC_OAUTH.redirectUri} URL, got ${url.origin}${url.pathname}` };
  }
  const oauthError = url.searchParams.get('error');
  if (oauthError) {
    return { ok: false, error: `${oauthError}: ${url.searchParams.get('error_description') ?? ''}`.trim() };
  }
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return { ok: false, error: 'URL has no code/state parameters.' };
  return { ok: true, code, state };
}
