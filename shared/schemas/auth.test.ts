import { describe, expect, it } from 'vitest';
import { LoginBody, SetupBody } from './auth';

const setup = (over: Record<string, unknown> = {}) => ({
  setupCode: 'ABCD-EFGH',
  username: 'organizer',
  password: 'correct horse',
  ...over,
});

describe('SetupBody', () => {
  it('normalizes the username to trimmed lower case', () => {
    expect(SetupBody.parse(setup({ username: '  Ash.Ketchum ' })).username).toBe('ash.ketchum');
  });

  it.each([
    ['too short', 'ab'],
    ['too long', 'a'.repeat(33)],
    ['spaces inside', 'ash ketchum'],
    ['markup', '<script>'],
  ])('rejects a username that is %s', (_l, username) => {
    expect(SetupBody.safeParse(setup({ username })).success).toBe(false);
  });

  it('accepts the username length bounds', () => {
    expect(SetupBody.safeParse(setup({ username: 'abc' })).success).toBe(true);
    expect(SetupBody.safeParse(setup({ username: 'a'.repeat(32) })).success).toBe(true);
  });

  it('requires a password of 8–256 characters', () => {
    expect(SetupBody.safeParse(setup({ password: '1234567' })).success).toBe(false);
    expect(SetupBody.safeParse(setup({ password: '12345678' })).success).toBe(true);
    expect(SetupBody.safeParse(setup({ password: 'x'.repeat(256) })).success).toBe(true);
    // Bounded so a huge body can't make scrypt chew on megabytes.
    expect(SetupBody.safeParse(setup({ password: 'x'.repeat(257) })).success).toBe(false);
  });

  it('requires the setup code', () => {
    expect(SetupBody.safeParse(setup({ setupCode: '' })).success).toBe(false);
    expect(SetupBody.safeParse(setup({ setupCode: undefined })).success).toBe(false);
  });

  it.each([null, 42, ['organizer']])('rejects a non-string username %j', (username) => {
    expect(SetupBody.safeParse(setup({ username })).success).toBe(false);
  });
});

describe('LoginBody', () => {
  it('normalizes the username the same way setup does', () => {
    expect(LoginBody.parse({ username: ' Organizer ', password: 'x' }).username).toBe('organizer');
  });

  it('does not apply the new-password policy to logins, but still bounds the length', () => {
    expect(LoginBody.safeParse({ username: 'organizer', password: 'short' }).success).toBe(true);
    expect(LoginBody.safeParse({ username: 'organizer', password: '' }).success).toBe(false);
    expect(LoginBody.safeParse({ username: 'organizer', password: 'x'.repeat(257) }).success).toBe(false);
  });

  it('rejects a missing username', () => {
    expect(LoginBody.safeParse({ password: 'x' }).success).toBe(false);
  });
});
