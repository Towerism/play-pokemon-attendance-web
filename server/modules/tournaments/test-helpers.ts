/** Test-only stand-ins and factories for the tournaments module. Not imported by production code. */
import type { TemplateBody } from '../../../shared/schemas/tournaments';
import type { ActingConnection, ConnectionView } from '../pokemon/connection';
import { PokemonUpstreamError } from '../pokemon/ports/errors';
import type { Format, Series, Tournament, TournamentChanges, TournamentDetails, Venue } from '../pokemon/ports/play-tools-gateway';

export const GROUP = 'group-1';
export const OLIVE: ActingConnection = { id: 1, professorPlayerId: '9999991', professorName: 'Olive Organizer', status: 'connected' };
export const BROCK: ActingConnection = { id: 2, professorPlayerId: '9999992', professorName: 'Brock', status: 'connected' };

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
    registration: { kind: 'on_site', opensBeforeMin: 60, closesAfterMin: 15, admission: null },
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
    tournaments: [] as StubTournament[],
    series: [] as Series[],
    formats: [{ product: 'tcg', categories: ['tcg_std', 'tcg_exp'] }] as Format[],
    venues: [{ id: VENUE.id, name: 'Card Shop', formattedAddress: '1 Main St', country: 'US', timeZone: 'America/Chicago' }] as Venue[],
    /** `method@connectionId` (or `method`) → throw this from the next such call. */
    failNext: new Map<string, PokemonUpstreamError>(),
    /** Every `editTournament` call, with the connection it was made as. */
    edits: [] as { as: number; tournamentId: string; changes: TournamentChanges }[],
    calls: [] as string[],
    connection: {
      status: 'connected',
      reason: null,
      connectedAt: new Date(0),
      lastRefreshedAt: new Date(0),
      league: { id: GROUP, name: 'Card Shop', displayId: 'L5012', canSubmit: true },
      connectionId: 1,
      professor: { playerId: OLIVE.professorPlayerId, name: OLIVE.professorName },
    } as ConnectionView,
  };

  async function call<T>(as: number, name: string, run: (who: string) => T): Promise<T> {
    state.calls.push(`${name}@${as}`);
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
          .map(({ organizer: _o, category: _c, applicationState: _a, details: _d, ...t }) => t),
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
    listSeries: (groupId: string) => call(as, 'listSeries', () => (groupId === GROUP ? [...state.series] : [])),
    listFormats: (_country: string) => call(as, 'listFormats', () => [...state.formats]),
    listVenues: (_groupId: string, _country: string) => call(as, 'listVenues', () => [...state.venues]),
  });

  return {
    state,
    gateway,
    connections: {
      getStatus: () => state.connection,
      listActingConnections: (): ActingConnection[] => state.professors.map((p) => ({ ...p })),
    },
  };
}
