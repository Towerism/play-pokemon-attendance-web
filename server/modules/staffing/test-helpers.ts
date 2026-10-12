/** Test-only stand-ins for the staffing module's upstream ports. Not imported by production code. */
import type { PlayerId } from '../../../shared/types/ids';
import type { ConnectionView } from '../pokemon/connection';
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

/** An in-memory play-tools: tournaments of any league, their participants, and a log of every call. */
export function stubPlayTools() {
  const state = {
    tournaments: [] as TournamentDetails[],
    participants: new Map<string, TournamentParticipant[]>(),
    /** Tournament ids `getTournament` answers `not_found` for (deleted after being listed). */
    gone: new Set<string>(),
    /** Throw this from the next call of the named method. */
    failNext: new Map<string, PokemonUpstreamError>(),
    calls: [] as string[],
    connection: {
      status: 'connected',
      reason: null,
      connectedAt: new Date(0),
      lastRefreshedAt: new Date(0),
      league: { id: GROUP, name: 'Card Shop', displayId: 'L5012', canSubmit: true },
      connectionId: 1,
      professor: { playerId: '0012345', name: 'Ash Ketchum' },
    } as ConnectionView,
  };
  let inFlight = 0;
  let maxInFlight = 0;

  async function call<T>(name: string, arg: string, run: () => T): Promise<T> {
    state.calls.push(`${name} ${arg}`);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, 1));
      const failure = state.failNext.get(name);
      if (failure) {
        state.failNext.delete(name);
        throw failure;
      }
      return run();
    } finally {
      inFlight--;
    }
  }

  const gateway = {
    listStaffRoles: () => ROLES,
    listTournaments: (range?: { from: Date; to: Date }) =>
      call('listTournaments', range ? range.from.toISOString() : 'all', () =>
        state.tournaments
          .filter((t) => !range || (t.startsAt && t.startsAt >= range.from && t.startsAt < range.to))
          .map(({ organizerPlayerId: _o, ...t }) => t as Tournament),
      ),
    getTournament: (id: string) =>
      call('getTournament', id, () => {
        const t = state.tournaments.find((x) => x.id === id);
        if (!t || state.gone.has(id)) throw new PokemonUpstreamError('not_found', `No tournament ${id}`);
        return t;
      }),
    listTournamentParticipants: (id: string) => call('listTournamentParticipants', id, () => [...(state.participants.get(id) ?? [])]),
  };

  return {
    state,
    gateway: () => gateway,
    connections: { getStatus: () => state.connection },
    maxConcurrentCalls: () => maxInFlight,
  };
}
