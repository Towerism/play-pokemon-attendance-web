/** Test-only stand-ins for the staffing module's upstream ports. Not imported by production code. */
import type { PlayerId } from '../../../shared/types/ids';
import type { ActingConnection, ConnectionView } from '../pokemon/connection';
import { PokemonUpstreamError } from '../pokemon/ports/errors';
import type {
  StaffRole,
  Tournament,
  TournamentDetails,
  TournamentParticipant,
} from '../pokemon/ports/play-tools-gateway';

export const GROUP = 'group-1';

export const ROLES: readonly StaffRole[] = [
  { code: 'judge', label: 'Judge' },
  { code: 'headjudge', label: 'Head Judge' },
  { code: 'scorekeeper', label: 'Scorekeeper' },
  { code: 'administration', label: 'Support Staff' },
  { code: 'translator', label: 'Translator' },
];

const DAY = 86_400_000;

export function tournament(id: string, opts: Partial<Tournament> & { organizer?: string } = {}): TournamentDetails {
  const startsAt = opts.startsAt === undefined ? new Date('2026-10-14T23:30:00Z') : opts.startsAt;
  return {
    id,
    name: opts.name === undefined ? `League Challenge ${id}` : opts.name,
    displayId: opts.displayId === undefined ? `26-10-${id}` : opts.displayId,
    groupId: opts.groupId === undefined ? GROUP : opts.groupId,
    products: ['tcg'],
    startsAt,
    status: 'sanctioned',
    editableUntil: opts.editableUntil === undefined ? (startsAt && new Date(startsAt.getTime() + 90 * DAY)) : opts.editableUntil,
    organizerPlayerId: (opts.organizer ?? '9999991') as PlayerId,
  };
}

export const staffer = (playerId: string, role: string, name = '', recordId = `rec-${playerId}`): TournamentParticipant => ({
  recordId,
  playerId: playerId as PlayerId,
  role,
  isStaff: true,
  name,
});

export const playing = (playerId: string, name = ''): TournamentParticipant => ({
  recordId: `rec-${playerId}`,
  playerId: playerId as PlayerId,
  role: null,
  isStaff: false,
  name,
});

/** A connected professor in the stub; `upstreamAs` is who play-tools knows the login as (default: their player id). */
export type StubProfessor = ActingConnection & { upstreamAs?: string };

/** The default professor: the organizer `tournament()` uses. */
export const OLIVE: StubProfessor = { id: 1, professorPlayerId: '9999991', professorName: 'Olive Organizer', status: 'connected' };

/**
 * An in-memory play-tools as several professors see it (S6): each connection lists only the
 * tournaments its professor organizes, only the organizer reads a tournament's records, and
 * anyone reads its details. Every call is logged with the connection that made it.
 */
export function stubPlayTools() {
  const state = {
    tournaments: [] as TournamentDetails[],
    participants: new Map<string, TournamentParticipant[]>(),
    /** Tournament ids `getTournament` answers `not_found` for (deleted after being listed). */
    gone: new Set<string>(),
    /** Throw this from the next call of the named method. */
    failNext: new Map<string, PokemonUpstreamError>(),
    calls: [] as string[],
    /** Every call with the connection id it was made as. */
    callsAs: [] as { call: string; as: number }[],
    /** `method@connectionId` → throw this from that connection's next call of the method. */
    failNextAs: new Map<string, PokemonUpstreamError>(),
    professors: [{ ...OLIVE }] as StubProfessor[],
    connection: {
      status: 'connected',
      reason: null,
      connectedAt: new Date(0),
      lastRefreshedAt: new Date(0),
      league: { id: GROUP, name: 'Card Shop', displayId: 'L5012', canSubmit: true },
      connectionId: 1,
      professor: { playerId: '9999991', name: 'Olive Organizer' },
    } as ConnectionView,
  };
  let inFlight = 0;
  let maxInFlight = 0;

  async function call<T>(as: number, name: string, arg: string, run: (who: string | undefined) => T): Promise<T> {
    state.calls.push(`${name} ${arg}`);
    state.callsAs.push({ call: `${name} ${arg}`, as });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, 1));
      const own = state.failNextAs.get(`${name}@${as}`);
      if (own) {
        state.failNextAs.delete(`${name}@${as}`);
        throw own;
      }
      const failure = state.failNext.get(name);
      if (failure) {
        state.failNext.delete(name);
        throw failure;
      }
      const p = state.professors.find((x) => x.id === as);
      if (!p) throw new PokemonUpstreamError('not_connected', 'No Pokémon account is connected. Connect one in Settings.');
      if (p.status === 'needs_reconnect') throw new PokemonUpstreamError('needs_reconnect', 'The Pokémon login was refused.');
      return run(p.upstreamAs ?? p.professorPlayerId ?? undefined);
    } finally {
      inFlight--;
    }
  }

  const gatewayAs = (as: number) => ({
    listStaffRoles: () => ROLES,
    listTournaments: (range?: { from: Date; to: Date }) =>
      call(as, 'listTournaments', range ? range.from.toISOString() : 'all', (who) =>
        state.tournaments
          .filter((t) => t.organizerPlayerId === who)
          .filter((t) => !range || (t.startsAt && t.startsAt >= range.from && t.startsAt < range.to))
          .map(({ organizerPlayerId: _o, ...t }) => t as Tournament),
      ),
    getTournament: (id: string) =>
      call(as, 'getTournament', id, () => {
        const t = state.tournaments.find((x) => x.id === id);
        if (!t || state.gone.has(id)) throw new PokemonUpstreamError('not_found', `No tournament ${id}`);
        return t;
      }),
    listTournamentParticipants: (id: string) =>
      call(as, 'listTournamentParticipants', id, (who) => {
        const t = state.tournaments.find((x) => x.id === id);
        if (t && t.organizerPlayerId !== who) throw new PokemonUpstreamError('forbidden', 'Only the organizer manages staff.', { status: 403 });
        return [...(state.participants.get(id) ?? [])];
      }),
  });

  return {
    state,
    /** The gateway as one connection; `null` serves only the role list (no call). */
    gateway: (connectionId: number | null) => gatewayAs(connectionId ?? 0),
    connections: {
      getStatus: () => state.connection,
      listActingConnections: (): ActingConnection[] => state.professors.map(({ upstreamAs: _u, ...p }) => ({ ...p })),
    },
    /** Connects another professor (or replaces one with the same id). */
    addProfessor(p: Partial<StubProfessor> & { id: number; professorPlayerId: string | null }): StubProfessor {
      const added: StubProfessor = { professorName: null, status: 'connected', ...p };
      state.professors = [...state.professors.filter((x) => x.id !== p.id), added];
      return added;
    },
    maxConcurrentCalls: () => maxInFlight,
  };
}
