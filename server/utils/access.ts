import type { H3Event } from 'h3';
import type { Actor } from '../modules/accounts/service';
import { DEFAULT_LEAGUE_ID } from '../modules/leagues';

/**
 * Who is calling (ADR-0015 §4): the session's user, read from the database on every request, so a role change or a
 * removal counts at once and the cookie is never trusted for either. A missing or removed user's session is cleared.
 */
export async function requireActor(event: H3Event): Promise<Actor> {
  const { user } = await requireUserSession(event);
  const actor = useAccounts().actor(user.id);
  if (!actor) {
    await clearUserSession(event);
    throw createError({ statusCode: 401, message: 'Sign in again.' });
  }
  return actor;
}

/**
 * A league member and their league (v1: the single seeded league): the owner, or a professor whose Pokémon account is
 * confirmed in the league's activity group (ADR-0015 §3). Anyone else gets 403 `not_a_member`, or `reverify_required` for a
 * professor who accepted a password reset link and hasn't completed a Pokémon connect since (§8).
 */
export async function requireMember(event: H3Event): Promise<{ leagueId: string; actor: Actor }> {
  const actor = await requireActor(event);
  const { member, waiting } = usePokemon().access(actor);
  if (waiting === 'reverify_required') {
    throw createError({
      statusCode: 403,
      message: "Log in to Pokémon again in Settings to confirm it's you after your password reset.",
      data: { code: 'reverify_required' },
    });
  }
  if (!member) {
    throw createError({
      statusCode: 403,
      message: "Your Pokémon account isn't confirmed in this league yet. Open Settings to connect it.",
      data: { code: 'not_a_member' },
    });
  }
  return { leagueId: DEFAULT_LEAGUE_ID, actor };
}

/** The owner and their league; a professor gets 403 `owner_only`. */
export async function requireOwner(event: H3Event): Promise<{ leagueId: string; actor: Actor }> {
  const actor = await requireActor(event);
  if (actor.role !== 'owner') {
    throw createError({ statusCode: 403, message: 'Only the owner of this app can do that.', data: { code: 'owner_only' } });
  }
  return { leagueId: DEFAULT_LEAGUE_ID, actor };
}
