/** Test-only helpers for the pokemon module. Not imported by production code. */
import type { Actor } from '../accounts/service';
import { type ActingConnection, ConnectionAccessError, type PokemonConnectionService, type UpstreamLeague } from './connection';
import { PokemonUpstreamError } from './ports/errors';

/** An unsigned JWT with the claims Hydra puts in a play-tools access token (S1). */
export function fakeAccessToken(claims: { sub: string; exp: number; jti?: string }): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ aud: ['https://op-core.pokemon.com'], client_id: 'op-tools-app', ...claims })}.sig`;
}


/** What a stub connection is unless a test says otherwise: the owner's (user 1), a member that may submit. */
export const HELD_BY_OWNER = { userId: 1, membership: 'member', canSubmit: true } as const;

/** The install's owner, as the access guards hand them to services. */
export const OWNER: Actor = { userId: 1, username: 'organizer', role: 'owner' };

/** A professor who signed in (ADR-0015 §1). */
export const professorActor = (userId: number, username = `prof${userId}`): Actor => ({ userId, username, role: 'professor' });

/**
 * The connection lookups other modules use, over a stub list of connections, applying the pokemon module's holder
 * rules (tested there): only a connection the actor holds is theirs to write through.
 */
export function stubConnections(opts: {
  professors: () => readonly ActingConnection[];
  league: () => (UpstreamLeague & { canSubmit?: boolean }) | null;
}): Pick<
  PokemonConnectionService,
  'league' | 'listActingConnections' | 'listReadableConnections' | 'actingConnection' | 'readingConnection' | 'access'
> {
  const list = () => opts.professors().map((p) => ({ ...p }));
  return {
    league: () => {
      const l = opts.league();
      return l && { id: l.id, name: l.name, displayId: l.displayId };
    },
    listActingConnections: list,
    listReadableConnections: () => list().filter((c) => c.membership !== 'outside'),
    actingConnection(actor, professorPlayerId) {
      const c = list().find((x) => x.professorPlayerId === professorPlayerId);
      if (!c) throw new ConnectionAccessError('organizer_not_connected', `Professor ${professorPlayerId} isn't connected.`, professorPlayerId);
      if (c.userId !== actor.userId) throw new ConnectionAccessError('not_your_connection', `Only the user who connected them can.`, professorPlayerId);
      if (c.status === 'needs_reconnect') throw new ConnectionAccessError('needs_reconnect', `Reconnect ${c.professorName ?? professorPlayerId} in Settings.`, professorPlayerId);
      return { connectionId: c.id };
    },
    readingConnection(_leagueId, actor) {
      const usable = list().filter((c) => c.membership === 'member' && c.status === 'connected');
      const pick = (actor && usable.find((c) => c.userId === actor.userId)) ?? usable[0];
      if (!pick) throw new PokemonUpstreamError('not_connected', 'No Pokémon account confirmed in the league is connected.');
      return pick.id;
    },
    access(actor) {
      if (actor.role === 'owner') return { member: true, waiting: null };
      const held = list().find((c) => c.userId === actor.userId);
      if (!held) return { member: false, waiting: 'no_connection' };
      return held.membership === 'member' ? { member: true, waiting: null } : { member: false, waiting: held.membership };
    },
  };
}
