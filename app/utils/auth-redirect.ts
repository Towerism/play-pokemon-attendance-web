export interface RouteLike {
  path: string;
  fullPath: string;
  query?: Record<string, unknown>;
}

export type AuthRedirect = string | { path: string; query?: Record<string, string> } | undefined;

/**
 * Where the auth middleware should send a navigation, or `undefined` to let it
 * through. `/login` is the only page outside the login wall (architecture §8).
 */
export function authRedirect(to: RouteLike, loggedIn: boolean): AuthRedirect {
  if (to.path === '/login') {
    return loggedIn ? safeLocalPath(to.query?.redirect) : undefined;
  }
  if (loggedIn) return undefined;
  return to.fullPath === '/' ? { path: '/login' } : { path: '/login', query: { redirect: to.fullPath } };
}

/** Only same-site paths: no `//host`, `/\host` or `scheme:` open redirects. */
function safeLocalPath(target: unknown): string {
  return typeof target === 'string' && /^\/(?![/\\])/.test(target) ? target : '/';
}
