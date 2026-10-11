import { PokemonUpstreamError } from '../../ports/errors';
import type { PtcOAuthClient, TokenGrant } from '../../ports/ptc-oauth';
import { fetchUpstream, jsonOrUndefined, throttleOrServerError } from '../http';
import { PTC_OAUTH } from './constants';
import { buildAuthorizeUrl } from './pkce';
import { AccessTokenClaims, OAuthErrorResponse, TokenResponse, decodeJwtPayload } from './wire';

export interface PtcOAuthClientOptions {
  /** Replaces `https://access.pokemon.com/` (test doubles only; `NUXT_POKEMON_ACCESS_URL`). */
  baseUrl?: string;
  now?: () => Date;
}

/**
 * PtcOAuthAdapter (architecture §4.1): authorization code + PKCE and refresh
 * against Hydra as the public `op-tools-app` client. Token values never appear
 * in errors or logs.
 */
export function createPtcOAuthClient(opts: PtcOAuthClientOptions = {}): PtcOAuthClient {
  const now = opts.now ?? (() => new Date());
  const endpoint = (path: string) => new URL(path, opts.baseUrl || PTC_OAUTH.issuer).toString();

  async function post(path: string, form: Record<string, string>, what: string): Promise<Response> {
    const res = await fetchUpstream(
      endpoint(path),
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams(form),
      },
      what,
    );
    if (res.ok) return res;
    throw throttleOrServerError(res, what) ?? oauthError(res.status, await jsonOrUndefined(res), what);
  }

  async function grant(form: Record<string, string>, what: string): Promise<TokenGrant> {
    const res = await post('oauth2/token', { ...form, client_id: PTC_OAUTH.clientId }, what);
    const issuedAt = now();
    const parsed = TokenResponse.safeParse(await jsonOrUndefined(res));
    if (!parsed.success) throw shapeError(what, `token response: ${issuePaths(parsed.error.issues)}`);

    let claims: AccessTokenClaims;
    try {
      claims = AccessTokenClaims.parse(decodeJwtPayload(parsed.data.access_token));
    } catch {
      throw shapeError(what, 'the access token is not a JWT with a subject');
    }
    return {
      accessToken: parsed.data.access_token,
      expiresAt: new Date(issuedAt.getTime() + parsed.data.expires_in * 1000),
      subject: claims.sub,
      refreshToken: parsed.data.refresh_token ?? null,
    };
  }

  return {
    authorizeUrl(challenge, state) {
      return buildAuthorizeUrl(challenge, state, endpoint('oauth2/auth')).toString();
    },

    exchangeCode(code, verifier) {
      return grant(
        { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: PTC_OAUTH.redirectUri },
        'Pokémon login',
      );
    },

    refresh(refreshToken) {
      return grant({ grant_type: 'refresh_token', refresh_token: refreshToken }, 'Pokémon token refresh');
    },

    async revoke(refreshToken) {
      await post(
        'oauth2/revoke',
        { token: refreshToken, token_type_hint: 'refresh_token', client_id: PTC_OAUTH.clientId },
        'Pokémon disconnect',
      );
    },
  };
}

function oauthError(status: number, body: unknown, what: string): PokemonUpstreamError {
  const parsed = OAuthErrorResponse.safeParse(body);
  const error = parsed.success ? parsed.data.error : `HTTP ${status}`;
  const description = parsed.success && parsed.data.error_description ? `: ${parsed.data.error_description}` : '';
  if (error === 'invalid_grant') {
    return new PokemonUpstreamError('needs_reconnect', `${what}: Pokémon no longer accepts this login${description}`, { status });
  }
  return new PokemonUpstreamError('forbidden', `${what}: Pokémon refused the request (${error}${description})`, { status });
}

function shapeError(what: string, detail: string): PokemonUpstreamError {
  return new PokemonUpstreamError('unexpected_shape', `${what}: unexpected ${detail}.`);
}

/** Paths only: Zod messages for a token response could quote the token. */
function issuePaths(issues: readonly { path: readonly PropertyKey[] }[]): string {
  return issues.map((i) => i.path.map(String).join('.') || '(root)').join(', ');
}
