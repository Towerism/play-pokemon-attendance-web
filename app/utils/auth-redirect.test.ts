import { describe, expect, it } from 'vitest';
import { authRedirect, waitingRedirect } from './auth-redirect';

describe('authRedirect', () => {
  it('sends a logged-out visitor to /login, remembering where they were going', () => {
    expect(authRedirect({ path: '/regulars', fullPath: '/regulars?x=1' }, false)).toEqual({
      path: '/login',
      query: { redirect: '/regulars?x=1' },
    });
  });

  it('does not add a redirect back to the home page', () => {
    expect(authRedirect({ path: '/', fullPath: '/' }, false)).toEqual({ path: '/login' });
  });

  it('lets a logged-out visitor see /login', () => {
    expect(authRedirect({ path: '/login', fullPath: '/login' }, false)).toBeUndefined();
  });

  it('lets a logged-in user through', () => {
    expect(authRedirect({ path: '/regulars', fullPath: '/regulars' }, true)).toBeUndefined();
  });

  it('moves a logged-in user off /login to where they were going', () => {
    expect(authRedirect({ path: '/login', fullPath: '/login?redirect=/players', query: { redirect: '/players' } }, true)).toBe(
      '/players',
    );
    expect(authRedirect({ path: '/login', fullPath: '/login' }, true)).toBe('/');
  });

  it.each(['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)'])(
    'ignores an off-site redirect target %j',
    (redirect) => {
      expect(authRedirect({ path: '/login', fullPath: '/login', query: { redirect } }, true)).toBe('/');
    },
  );
});

describe('waitingRedirect (ADR-0015 §3: a professor not yet in the league sees only Settings)', () => {
  it('sends a non-member to Settings from any other page, and lets them stay there', () => {
    expect(waitingRedirect('/', { member: false })).toBe('/settings');
    expect(waitingRedirect('/tournaments', { member: false })).toBe('/settings');
    expect(waitingRedirect('/settings', { member: false })).toBeUndefined();
  });

  it('lets a member go anywhere, and waits while access is not known yet', () => {
    expect(waitingRedirect('/tournaments', { member: true })).toBeUndefined();
    expect(waitingRedirect('/tournaments', null)).toBeUndefined();
    expect(waitingRedirect('/login', { member: false })).toBeUndefined();
  });
});

describe('the invite page (ADR-0015 §6)', () => {
  it('is outside the login wall, and a signed-in browser stays on it to be told to log out', () => {
    expect(authRedirect({ path: '/invite', fullPath: '/invite' }, false)).toBeUndefined();
    expect(authRedirect({ path: '/invite', fullPath: '/invite' }, true)).toBeUndefined();
  });

  it('is never sent to Settings by the waiting room', () => {
    expect(waitingRedirect('/invite', { member: false })).toBeUndefined();
  });
});
