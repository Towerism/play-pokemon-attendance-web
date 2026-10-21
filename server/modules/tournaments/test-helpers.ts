/** Test-only stand-ins and factories for the tournaments module. Not imported by production code. */
import type { TemplateBody } from '../../../shared/schemas/tournaments';
import type { ActingConnection } from '../pokemon/connection';
import { HELD_BY_OWNER, type StubLease, stubConnections } from '../pokemon/test-connections';
import { PokemonUpstreamError } from '../pokemon/ports/errors';
import type { Format, Series, Tournament, TournamentChanges, TournamentDetails, TournamentParticipant, Venue } from '../pokemon/ports/play-tools-gateway';

export const GROUP = 'group-1';
export const OLIVE: ActingConnection = { id: 1, professorPlayerId: '9999991', professorName: 'Olive Organizer', status: 'connected', ...HELD_BY_OWNER };
export const BROCK: ActingConnection = { id: 2, professorPlayerId: '9999992', professorName: 'Brock', status: 'connected', ...HELD_BY_OWNER };

export const VENUE = { id: '00000000-0000-4000-8000-000000000051', label: 'Card Shop', timeZone: 'America/Chicago', country: 'US' };

/** A valid template body (what the route hands the service after parsing). */
export function templateBody(overrides: Partial<TemplateBody> = {}): TemplateBody {
  return {
    name: 'League Challenge {month}',
    organizerPlayerId: OLIVE.professorPlayerId,
    product: 'tcg',
    category: 'tcg_std',
    type: { kind: 'premier', seriesMatch: 'League Challenge' },
    venue: VENUE,
    startTime: '18:00',
    registration: { kind: 'on_site', opensBeforeMin: 60, closesAfterMin: 15, admissionCents: null },
    contactEmail: 'league@example.com',
    contactPhone: null,
    details: null,
    eventWebsite: null,
    ...overrides,
  } as TemplateBody;
}

export function series(id: string, name: string, from: string, to: string, product = 'tcg'): Series {
  return { id, name, product, categories: ['tcg_std'], tags: [], playTemplate: null, windows: { US: { from, to } } };
}

/** A play-tools tournament as the stub holds it: listed, plus the details only `getTournament` reads. */
export type StubTournament = Tournament & {
  organizer: string;
  category?: string;
  applicationState?: string;
  /** What only the details read carries (venue, contact, registration…); an edit writes here. */
  details?: { -readonly [K in keyof TournamentDetails]?: TournamentDetails[K] };
};

/** Who a tournament lists: its organizer, then `players` players and `staff` judges. Names and ids are made up. */
export function participants(organizer: string, counts: { players?: number; staff?: number } = {}): TournamentParticipant[] {
  const person = (playerId: string, role: string | null): TournamentParticipant => ({
    recordId: `rec-${playerId}`,
    playerId: playerId as never,
    role,
    isStaff: role !== null,
    name: `Person ${playerId}`,
  });
  return [
    person(organizer, 'organizer'),
    ...Array.from({ length: counts.players ?? 0 }, (_, i) => person(`8000${i}`, null)),
    ...Array.from({ length: counts.staff ?? 0 }, (_, i) => person(`7000${i}`, 'judge')),
  ];
}

export function upstreamTournament(id: string, startsAt: string, opts: Partial<StubTournament> = {}): StubTournament {
  return {
    id,
    name: `Cup ${id}`,
    displayId: `26-10-${id}`,
    groupId: GROUP,
    products: ['tcg'],
    startsAt: new Date(startsAt),
    status: 'sanctioned',
    editableUntil: null,
    organizer: OLIVE.professorPlayerId!,
    ...opts,
  };
}

/**
 * An in-memory play-tools for the reads this module makes, as several professors: each lists only the
 * tournaments they organize. Every call is logged with the connection it was made as.
 */
export function stubPlayTools() {
  const state = {
    professors: [{ ...OLIVE }] as ActingConnection[],
    /** Live tournament leases (ADR-0015 §5). */
    leases: [] as StubLease[],
    tournaments: [] as StubTournament[],
    series: [] as Series[],
    formats: [{ product: 'tcg', categories: ['tcg_std', 'tcg_exp'] }] as Format[],
    venues: [{ id: VENUE.id, name: 'Card Shop', formattedAddress: '1 Main St', country: 'US', timeZone: 'America/Chicago' }] as Venue[],
    /** `method@connectionId` (or `method`) → throw this from the next such call. */
    failNext: new Map<string, PokemonUpstreamError>(),
    /** Every `editTournament` call, with the connection it was made as. */
    edits: [] as { as: number; tournamentId: string; changes: TournamentChanges }[],
    /** Who each tournament lists (players and staff), by guid; none when unset. */
    participants: new Map<string, TournamentParticipant[]>(),
    /** Every `cancelTournament` call, with the connection it was made as. */
    cancels: [] as { as: number; tournamentId: string }[],
    calls: [] as string[],
    /** Awaited at the start of every call, after it is logged: a test holds a call open with it. */
    gate: undefined as ((name: string, as: number) => Promise<void>) | undefined,
    /** The league's chosen activity group (ADR-0015 §3), or null. */
    connection: { league: { id: GROUP, name: 'Card Shop', displayId: 'L5012' } as { id: string; name: string; displayId: string | null } | null },
  };

  async function call<T>(as: number, name: string, run: (who: string) => T): Promise<T> {
    state.calls.push(`${name}@${as}`);
    await state.gate?.(name, as);
    for (const key of [`${name}@${as}`, name]) {
      const failure = state.failNext.get(key);
      if (failure) {
        state.failNext.delete(key);
        throw failure;
      }
    }
    const p = state.professors.find((x) => x.id === as);
    if (!p) throw new PokemonUpstreamError('not_connected', 'No Pokémon account is connected.');
    if (p.status === 'needs_reconnect') throw new PokemonUpstreamError('needs_reconnect', 'The Pokémon login was refused.');
    return run(p.professorPlayerId!);
  }

  const gateway = (as: number) => ({
    listTournaments: (range?: { from: Date; to: Date }) =>
      call(as, 'listTournaments', (who) =>
        state.tournaments
          .filter((t) => t.organizer === who)
          .filter((t) => !range || (t.startsAt && t.startsAt >= range.from && t.startsAt < range.to))
          .map(({ organizer: _o, category: _c, applicationState, details: _d, ...t }) => ({ ...t, ...(applicationState !== undefined && { applicationState }) })),
      ),
    getTournament: (tournamentId: string) =>
      call(as, 'getTournament', (): TournamentDetails => {
        const t = state.tournaments.find((x) => x.id === tournamentId);
        if (!t) throw new PokemonUpstreamError('not_found', `No tournament ${tournamentId}.`);
        const { organizer, category, applicationState, details, ...listed } = t;
        return {
          ...listed,
          organizerPlayerId: organizer as never,
          organizerName: null,
          applicationState: applicationState ?? t.status,
          activityState: 'pending',
          category: category ?? 'tcg_std',
          series: null,
          venue: null,
          contact: { email: null, phone: null },
          registration: null,
          onSiteAdmission: null,
          thirdPartyRegistrationUrl: null,
          details: null,
          eventWebsite: null,
          ...details,
        };
      }),
    editTournament: (tournamentId: string, changes: TournamentChanges) =>
      call(as, 'editTournament', () => {
        state.edits.push({ as, tournamentId, changes });
        const t = state.tournaments.find((x) => x.id === tournamentId);
        if (!t) throw new PokemonUpstreamError('not_found', `No tournament ${tournamentId}.`);
        const d: Record<string, unknown> = { ...t.details };
        const listed = t as { -readonly [K in keyof StubTournament]: StubTournament[K] };
        if (changes.name !== undefined) listed.name = changes.name;
        if (changes.startsAt !== undefined) listed.startsAt = changes.startsAt;
        if (changes.category !== undefined) listed.category = changes.category;
        if (changes.venueId !== undefined) d.venue = { id: changes.venueId, timeZone: t.details?.venue?.timeZone ?? null };
        for (const k of ['contact', 'registration', 'onSiteAdmission', 'thirdPartyRegistrationUrl', 'details', 'eventWebsite'] as const) {
          if (changes[k] !== undefined) d[k] = changes[k];
        }
        t.details = d as StubTournament['details'];
        return 'edited' as const;
      }),
    listTournamentParticipants: (tournamentId: string) =>
      call(as, 'listTournamentParticipants', () => {
        if (!state.tournaments.some((x) => x.id === tournamentId)) throw new PokemonUpstreamError('not_found', `No tournament ${tournamentId}.`);
        return [...(state.participants.get(tournamentId) ?? [])];
      }),
    cancelTournament: (tournamentId: string) =>
      call(as, 'cancelTournament', (who) => {
        state.cancels.push({ as, tournamentId });
        const t = state.tournaments.find((x) => x.id === tournamentId);
        if (!t) throw new PokemonUpstreamError('not_found', `No tournament ${tournamentId}.`);
        if (t.organizer !== who) throw new PokemonUpstreamError('forbidden', 'Request not authorized for attempted action.');
        (t as { status: string }).status = 'cancelled';
        t.applicationState = 'cancelled';
        return 'cancelled' as const;
      }),
    listSeries: (groupId: string) => call(as, 'listSeries', () => (groupId === GROUP ? [...state.series] : [])),
    listFormats: (_country: string) => call(as, 'listFormats', () => [...state.formats]),
    listVenues: (_groupId: string, _country: string) => call(as, 'listVenues', () => [...state.venues]),
  });

  return {
    state,
    gateway,
    connections: stubConnections({ professors: () => state.professors, league: () => state.connection.league, leases: () => state.leases }),
  };
}
