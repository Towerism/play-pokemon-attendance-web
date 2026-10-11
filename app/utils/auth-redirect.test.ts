import { describe, expect, it } from 'vitest';
import { authRedirect } from './auth-redirect';

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
