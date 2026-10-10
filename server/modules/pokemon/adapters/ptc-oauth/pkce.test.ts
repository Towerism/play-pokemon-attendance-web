import { describe, expect, it } from 'vitest';
import { buildAuthorizeUrl, createPkcePair, parseCallbackUrl, s256Challenge } from './pkce';
import { decodeJwtPayload } from './wire';

describe('PKCE', () => {
  it('matches the RFC 7636 appendix B example', () => {
    expect(s256Challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('creates a 43-char verifier whose challenge is its S256', () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).toMatch(/^[\w-]{43}$/);
    expect(challenge).toBe(s256Challenge(verifier));
  });
});

describe('buildAuthorizeUrl', () => {
  it('carries the play-tools client parameters', () => {
    const url = buildAuthorizeUrl('chal', 'st');
    expect(url.origin + url.pathname).toBe('https://access.pokemon.com/oauth2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'op-tools-app',
      response_type: 'code',
      scope: 'openid organized_play offline',
      audience: 'https://op-core.pokemon.com',
      redirect_uri: 'https://play-tools.pokemon.com/loggedIn',
      state: 'st',
      code_challenge: 'chal',
      code_challenge_method: 'S256',
    });
  });
});

describe('parseCallbackUrl', () => {
  it('extracts code and state', () => {
    expect(parseCallbackUrl(' https://play-tools.pokemon.com/loggedIn?code=abc&state=xyz&scope=openid ')).toEqual({
      ok: true,
      code: 'abc',
      state: 'xyz',
    });
  });

  it.each([
    ['not a url', /Not a URL/],
    ['https://evil.example/loggedIn?code=a&state=b', /Expected/],
    ['https://play-tools.pokemon.com/loggedIn?state=b', /no code/],
    ['https://play-tools.pokemon.com/loggedIn?error=access_denied&error_description=nope', /access_denied: nope/],
  ])('rejects %s', (input, message) => {
    const r = parseCallbackUrl(input);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(message);
  });
});

describe('decodeJwtPayload', () => {
  it('decodes the payload segment', () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'u1', exp: 1 })).toString('base64url');
    expect(decodeJwtPayload(`h.${payload}.s`)).toEqual({ sub: 'u1', exp: 1 });
  });

  it('rejects opaque tokens', () => {
    expect(() => decodeJwtPayload('ory_at_abc')).toThrow('Not a JWT');
  });
});
