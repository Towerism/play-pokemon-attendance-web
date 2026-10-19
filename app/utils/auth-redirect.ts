export interface RouteLike {
  path: string;
  fullPath: string;
  query?: Record<string, unknown>;
}

export type AuthRedirect = string | { path: string; query?: Record<string, string> } | undefined;

/**
 * Where the auth middleware should send a navigation, or `undefined` to let it
 * through. `/login` and `/invite` are the pages outside the login wall (architecture §8). A signed-in browser stays on
 * `/invite`, which tells it to log out first (ADR-0015 §6).
 */
export function authRedirect(to: RouteLike, loggedIn: boolean): AuthRedirect {
  if (to.path === '/invite') return undefined;
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

/** Where a professor not yet confirmed in the league goes (ADR-0015 §3): only Settings, until they are a member. */
export function waitingRedirect(path: string, access: { member: boolean } | null | undefined): string | undefined {
  if (!access || access.member || path === '/settings' || path === '/login' || path === '/invite') return undefined;
  return '/settings';
}
