import { describe, expect, it } from 'vitest';
import { REDACTED, SENSITIVE_KEYS, redact, scrub } from './redact';

describe('redact', () => {
  it('hides every sensitive key at any depth, in objects and arrays, whatever its spelling', () => {
    const fields = {
      headers: { Authorization: 'Bearer abc', Cookie: 'sid=c1' },
      body: { refresh_token: 'r1', nested: [{ accessToken: 'a1', dob: '2012-01-01', 'ID-Token': 'i1' }] },
      tokenVaultKey: 'k1',
    };

    expect(redact(fields)).toEqual({
      headers: { Authorization: REDACTED, Cookie: REDACTED },
      body: { refresh_token: REDACTED, nested: [{ accessToken: REDACTED, dob: REDACTED, 'ID-Token': REDACTED }] },
      tokenVaultKey: REDACTED,
    });
  });

  it.each([
    'token', 'access_token', 'AccessToken', 'refreshToken', 'REFRESH-TOKEN', 'id_token', 'idToken',
    'authorization', 'Proxy-Authorization', 'cookie', 'set-cookie', 'password', 'sessionPassword',
    'NUXT_SESSION_PASSWORD', 'secret', 'client_secret', 'secretAccessKey', 'LITESTREAM_SECRET_ACCESS_KEY',
    'tokenVaultKey', 'NUXT_TOKEN_VAULT_KEY', 'code_verifier', 'authorizationCode', 'birthdate',
    'birth_date', 'dateOfBirth', 'DOB',
  ])('hides %s', (key) => {
    expect(redact({ [key]: 'value' })).toEqual({ [key]: REDACTED });
  });

  it.each(['tokenCount', 'tokenExpiresAt', 'tokenType', 'passwordSetAt', 'cookieName', 'code', 'state', 'playerId'])(
    'leaves the look-alike %s alone',
    (key) => {
      expect(redact({ [key]: 'value' })).toEqual({ [key]: 'value' });
    },
  );

  it('hides a whole object or array held under a sensitive key', () => {
    expect(redact({ cookie: { sid: 'x' }, token: ['a', 'b'] })).toEqual({ cookie: REDACTED, token: REDACTED });
  });

  it('leaves null and undefined sensitive values as they are, since absence leaks nothing', () => {
    expect(redact({ token: null, password: undefined })).toEqual({ token: null, password: undefined });
  });

  it('does not change the caller’s object', () => {
    const fields = { password: 'p', nested: { token: 't' } };
    redact(fields);
    expect(fields).toEqual({ password: 'p', nested: { token: 't' } });
  });

  it('turns an error into a plain object, scrubbing its message and stack and redacting its cause', () => {
    const cause = Object.assign(new Error('inner'), { token: 't3' });
    const err = Object.assign(new Error('upstream said Bearer xyz.123 and refresh_token=r2&x=1'), {
      cause,
      statusCode: 502,
    });

    const out = redact({ err }) as { err: Record<string, unknown> };

    expect(out.err).toMatchObject({
      type: 'Error',
      message: 'upstream said Bearer [REDACTED] and refresh_token=[REDACTED]&x=1',
      statusCode: 502,
      cause: { type: 'Error', message: 'inner', token: REDACTED },
    });
    expect(out.err.stack).toEqual(expect.any(String));
    expect(out.err.stack).not.toMatch(/xyz\.123|r2/);
  });

  it('replaces a circular reference instead of throwing', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(redact({ a })).toEqual({ a: { name: 'a', self: '[Circular]' } });
  });

  it('replaces a value whose getter throws instead of throwing', () => {
    const bad = Object.defineProperty({}, 'boom', {
      enumerable: true,
      get() {
        throw new Error('nope');
      },
    });
    expect(redact({ bad })).toEqual({ bad: { boom: '[Unserializable]' } });
  });

  it('cuts off anything nested deeper than 8 levels rather than printing it unredacted', () => {
    let deep: Record<string, unknown> = { token: 'leak' };
    for (let i = 0; i < 9; i++) deep = { next: deep };
    expect(JSON.stringify(redact(deep))).not.toContain('leak');
    expect(JSON.stringify(redact(deep))).toContain('[Truncated]');
  });

  it('keeps the list exact and normalized', () => {
    for (const key of SENSITIVE_KEYS) expect(key).toMatch(/^[a-z]+$/);
  });
});

describe('scrub', () => {
  it('hides bearer credentials, case-insensitively', () => {
    expect(scrub('header was bearer eyJhbGciOi.abc.def; next')).toBe('header was bearer [REDACTED]; next');
  });

  it('hides form-, query- and JSON-style values of sensitive names, keeping the rest', () => {
    expect(scrub('refresh_token=r2&x=1')).toBe('refresh_token=[REDACTED]&x=1');
    expect(scrub('{"access_token":"a2","expires_in":3600}')).toBe('{"access_token":"[REDACTED]","expires_in":3600}');
    expect(scrub('password=hunter2 and code_verifier=v1,')).toBe('password=[REDACTED] and code_verifier=[REDACTED],');
  });

  it('leaves look-alike names and ordinary text untouched', () => {
    expect(scrub('tokenCount=4 tokenType=Bearer')).toBe('tokenCount=4 tokenType=Bearer');
    expect(scrub('Submitted 12 players for 2026-10-10')).toBe('Submitted 12 players for 2026-10-10');
  });
});
