import type { Actor } from '../accounts/service';
import { type ActingConnection, ConnectionAccessError, type PokemonConnectionService } from '../pokemon/connection';
import { PokemonUpstreamError } from '../pokemon/ports/errors';
import type { TournamentDetails } from '../pokemon/ports/play-tools-gateway';
import { TournamentsError } from './errors';
import type { TournamentsGateway } from './service';

/**
 * May `actor` act in `organizerPlayerId`'s name (ADR-0015 §4)? Only through a connection they hold, as the pokemon
 * module's `actingConnection` decides; its refusals become this module's codes. A `local` change (a template, a
 * planned row) reaches nothing upstream, so a login needing a reconnect doesn't stop it. With `ownerCleanup`, the
 * owner may also make it when nobody holds that connection, so stale plans can be cleaned up.
 * @throws TournamentsError `organizer_not_connected`, `needs_reconnect`, `not_your_connection`
 */
export function assertMayActAs(
  connections: Pick<PokemonConnectionService, 'actingConnection' | 'listActingConnections'>,
  actor: Actor,
  organizerPlayerId: string,
  opts: { local?: boolean; ownerCleanup?: boolean } = {},
): void {
  try {
    connections.actingConnection(actor, organizerPlayerId, { kind: 'own' });
  } catch (err) {
    // A professor who must prove their login after a reset (ADR-0015 §8) gets the pokemon module's own refusal.
    if (!(err instanceof ConnectionAccessError) || err.code === 'reverify_required') throw err;
    if (opts.local && err.code === 'needs_reconnect') return;
    if (opts.ownerCleanup && err.code === 'organizer_not_connected' && actor.role === 'owner') return;
    const name = connections.listActingConnections().find((c) => c.professorPlayerId === organizerPlayerId)?.professorName ?? `Professor ${organizerPlayerId}`;
    const message =
      err.code === 'not_your_connection'
        ? `Only ${name} can change this.`
        : err.code === 'needs_reconnect'
          ? `Reconnect ${name} in Settings.`
          : `Professor ${organizerPlayerId} isn't connected. Connect their Pokémon account in Settings to act as them.`;
    throw new TournamentsError(err.code, message, { professorPlayerId: organizerPlayerId });
  }
}

/** Reads that mean "not this professor's", when looking for who organizes a guid. */
const NOT_THEIRS: ReadonlySet<string> = new Set(['not_found', 'forbidden', 'refused']);

export interface OrganizerRead {
  tournamentId: string;
  read: TournamentDetails;
  organizer: ActingConnection;
}

/**
 * Fresh reads of a play-tools tournament as its organizer (ADR-0009), for Edit… and Cancel…: the professor a template
 * names, or for a guid no row holds, each connected professor in turn until one can read it.
 */
export function organizerReads(deps: {
  connections: Pick<PokemonConnectionService, 'listActingConnections'>;
  gateway: (connectionId: number) => Pick<TournamentsGateway, 'getTournament'>;
}) {
  /** The organizer's connection for a request: refused when they aren't connected or must reconnect. */
  function requireActing(playerId: string): ActingConnection {
    const c = deps.connections.listActingConnections().find((x) => x.professorPlayerId === playerId);
    if (!c) {
      throw new TournamentsError('organizer_not_connected', `Professor ${playerId} isn't connected. Connect their Pokémon account in Settings to act as them.`, {
        professorPlayerId: playerId,
      });
    }
    if (c.status === 'needs_reconnect') {
      throw new TournamentsError('needs_reconnect', `Reconnect ${c.professorName ?? `Professor ${playerId}`} in Settings.`, { professorPlayerId: playerId });
    }
    return c;
  }

  async function read(c: ActingConnection, tournamentId: string): Promise<TournamentDetails> {
    try {
      return await deps.gateway(c.id).getTournament(tournamentId);
    } catch (err) {
      if (err instanceof PokemonUpstreamError && err.code === 'not_found') throw new TournamentsError('not_found', 'play-tools no longer has this tournament.');
      throw err;
    }
  }

  /** `first` read it; the organizer the read names acts, and reads it again unless that was them. Another league's is not found. */
  async function asOrganizer(group: string, tournamentId: string, first: ActingConnection, fresh: TournamentDetails): Promise<OrganizerRead> {
    if (fresh.groupId !== group) throw new TournamentsError('not_found', "This tournament isn't the league's.");
    if (fresh.organizerPlayerId === first.professorPlayerId) return { tournamentId, read: fresh, organizer: first };
    const organizer = requireActing(fresh.organizerPlayerId);
    return { tournamentId, read: await read(organizer, tournamentId), organizer };
  }

  return {
    requireActing,
    read,
    asOrganizer,

    /** A tournament a row links: read as the template's organizer first. */
    async ofRow(group: string, tournamentId: string, organizerPlayerId: string): Promise<OrganizerRead> {
      const c = requireActing(organizerPlayerId);
      return asOrganizer(group, tournamentId, c, await read(c, tournamentId));
    },

    /** A guid no row holds: read as each connected professor in turn. @throws TournamentsError `not_found` when nobody can */
    async ofGuid(group: string, guid: string): Promise<OrganizerRead> {
      for (const c of deps.connections.listActingConnections().filter((x) => x.status === 'connected')) {
        let fresh: TournamentDetails;
        try {
          fresh = await deps.gateway(c.id).getTournament(guid);
        } catch (err) {
          if (err instanceof PokemonUpstreamError && NOT_THEIRS.has(err.code)) continue;
          throw err;
        }
        return asOrganizer(group, guid, c, fresh);
      }
      throw new TournamentsError('not_found', 'No connected professor can read this tournament in play-tools.');
    },
  };
}
