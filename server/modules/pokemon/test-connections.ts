/** Test-only stand-ins for other modules' tests: actors, and the connection lookups they make. Not imported by production code. */
import type { Actor } from '../accounts/service';
import { type ActingConnection, ConnectionAccessError, type PokemonConnectionService, type UpstreamLeague } from './connection';
import { PokemonUpstreamError } from './ports/errors';

/** What a stub connection is unless a test says otherwise: the owner's (user 1), a member that may submit. */
export const HELD_BY_OWNER = { userId: 1, membership: 'member', canSubmit: true } as const;

/** The install's owner, as the access guards hand them to services. */
export const OWNER: Actor = { userId: 1, username: 'organizer', role: 'owner' };

/** A professor who signed in (ADR-0015 §1). */
export const professorActor = (userId: number, username = `prof${userId}`): Actor => ({ userId, username, role: 'professor' });

/** A live tournament lease, as a stub knows it (ADR-0015 §5). */
export interface StubLease {
  id: number;
  connectionId: number;
  tournamentId: string;
  lesseeUserId: number;
}

/**
 * The connection lookups other modules use, over a stub list of connections, applying the pokemon module's holder
 * rules (tested there): only a connection the actor holds is theirs to write through, or for one tournament's staff or
 * results, one lent to them by a live lease.
 */
export function stubConnections(opts: {
  professors: () => readonly ActingConnection[];
  league: () => (UpstreamLeague & { canSubmit?: boolean }) | null;
  leases?: () => readonly StubLease[];
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
    actingConnection(actor, professorPlayerId, scope) {
      const c = list().find((x) => x.professorPlayerId === professorPlayerId);
      if (!c) throw new ConnectionAccessError('organizer_not_connected', `Professor ${professorPlayerId} isn't connected.`, professorPlayerId);
      const lease =
        c.userId === actor.userId || scope.kind !== 'tournament'
          ? undefined
          : opts.leases?.().find((l) => l.connectionId === c.id && l.tournamentId === scope.tournamentId && l.lesseeUserId === actor.userId);
      if (c.userId !== actor.userId && !lease) throw new ConnectionAccessError('not_your_connection', `Only ${c.professorName ?? professorPlayerId} can change this.`, professorPlayerId);
      if (c.status === 'needs_reconnect') throw new ConnectionAccessError('needs_reconnect', `Reconnect ${c.professorName ?? professorPlayerId} in Settings.`, professorPlayerId);
      return { connectionId: c.id, leaseId: lease?.id ?? null };
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
