import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every API route calls exactly one access guard (ADR-0015 §4, architecture §7). The server suite checks what each
// listed route answers; this catches a route added later that forgets its guard, or takes the wrong one.

const API = join(process.cwd(), 'server', 'api');

/**
 * Routes that take no session guard: the public auth routes, the public invite routes (rate-limited, ADR-0015 §6), the
 * JSON 404 catch-all, and the bearer-only integrations.
 */
const UNGUARDED = new Set([
  'invites/check.post.ts',
  'invites/accept.post.ts',
  'auth/login.post.ts',
  'auth/logout.post.ts',
  'auth/setup.get.ts',
  'auth/setup.post.ts',
  '[...].ts',
  '[...].get.ts',
  '[...].post.ts',
  '[...].put.ts',
  '[...].patch.ts',
  '[...].delete.ts',
  'index.ts',
]);

/** The waiting room (ADR-0015 §3): what a professor not yet confirmed in the league may still call. */
const ACTOR = new Set([
  'settings.get.ts',
  'pokemon/connections.get.ts',
  'pokemon/connect/start.post.ts',
  'pokemon/connect/complete.post.ts',
  'pokemon/connections/[playerId].patch.ts',
  'pokemon/connections/[playerId].delete.ts',
]);

/** Owner only (ADR-0015 §4, §8): the league picker, thresholds, imports, integration tokens, clearing a session, professors. */
const OWNER = new Set([
  'professors/index.get.ts',
  'professors/invites/index.post.ts',
  'professors/invites/[id].delete.ts',
  'professors/[userId]/reset-link.post.ts',
  'professors/[userId].delete.ts',
  'leagues/upstream.get.ts',
  'settings.put.ts',
  'staff/import.post.ts',
  'players/import.post.ts',
  'integrations/tokens/index.get.ts',
  'integrations/tokens/index.post.ts',
  'integrations/tokens/[id].delete.ts',
  'sessions/[date]/clear.get.ts',
  'sessions/[date]/clear.post.ts',
]);

function routes(dir = API): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routes(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [relative(API, path).split(sep).join('/')] : [];
  });
}

const GUARDS = ['requireActor', 'requireMember', 'requireOwner'] as const;
const guardsIn = (route: string) => {
  const code = readFileSync(join(API, route), 'utf8');
  return GUARDS.filter((g) => new RegExp(`\\b${g}\\(`).test(code));
};

function expected(route: string): (typeof GUARDS)[number] | null {
  if (UNGUARDED.has(route) || route.startsWith('integrations/v1/')) return null;
  if (ACTOR.has(route)) return 'requireActor';
  if (OWNER.has(route)) return 'requireOwner';
  return 'requireMember';
}

describe('access guards on API routes', () => {
  const all = routes();

  it('finds the routes', () => {
    expect(all.length).toBeGreaterThan(80);
    for (const listed of [...ACTOR, ...OWNER]) expect(all).toContain(listed);
  });

  it.each(all)('%s calls the one guard the route table gives it', (route) => {
    const want = expected(route);
    expect(guardsIn(route)).toEqual(want ? [want] : []);
  });

  it('leaves no route on the old requireLeague', () => {
    expect(all.filter((r) => readFileSync(join(API, r), 'utf8').includes('requireLeague'))).toEqual([]);
  });
});
