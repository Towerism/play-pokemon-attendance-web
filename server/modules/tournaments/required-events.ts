import {
  type ListedInput,
  type PeriodCoverage,
  type PlannedInput,
  type SeriesInput,
  type UnreadProfessor,
  classOf,
  coverage,
} from '../../../shared/requirements/coverage';
import { type LocalDate, periodsFor } from '../../../shared/requirements/periods';
import { dateIn, localDay } from '../../../shared/time/local-time';
import type { SessionDate } from '../../../shared/types/ids';
import type { ActingConnection, PokemonConnectionService } from '../pokemon/connection';
import { PokemonUpstreamError } from '../pokemon/ports/errors';
import type { Series, Tournament } from '../pokemon/ports/play-tools-gateway';
import type { LiveReads } from './live-reads';
import type { Requirement, TournamentRequirements } from './requirements';
import type { TournamentsGateway } from './service';

/** Series windows are per country, and the app keeps no league country: the forms' default (ADR-0010 update #91). */
export const COVERAGE_COUNTRY = 'US';

/** How long a professor's listing is reused (ADR-0010 decision 12, #102). */
export const LISTING_TTL_MS = 5 * 60_000;

export interface RequiredEventsCoverage {
  timeZone: string;
  today: LocalDate;
  country: string;
  upstream: 'read' | 'not_connected' | 'league_not_selected';
  /** Professors whose listing failed; their tournaments can't be counted. */
  unread: UnreadProfessor[];
  /** No connected professor could read play-tools' series: no latest dates from windows. */
  seriesUnavailable: boolean;
  requirements: { requirement: Requirement; periods: PeriodCoverage[] }[];
}

export interface RequiredEvents {
  /** Coverage of the league's active requirements, from cached listings unless `refresh`. */
  read(leagueId: string, opts: { refresh: boolean }): Promise<RequiredEventsCoverage>;
  /** A tournament job ended: every cached listing may be out of date. */
  listingsChanged(): void;
}

/** A play-tools tournament and the professor whose listing returned it (they organize it, ADR-0009). */
export interface ListedTournament {
  tournament: Tournament;
  organizer: ActingConnection;
}

export interface RequiredEventsDeps {
  connections: Pick<PokemonConnectionService, 'getStatus' | 'listActingConnections'>;
  gateway: (connectionId: number) => Pick<TournamentsGateway, 'listTournaments' | 'getTournament'>;
  live: Pick<LiveReads, 'series'>;
  requirements: TournamentRequirements;
  /**
   * The planned rows coverage counts (not in play-tools, from the creatable window on, up to `to`), after the
   * schedules are planned and `unknown` rows are linked to what the listing shows, as Upcoming does.
   */
  planned(leagueId: string, to: LocalDate, group: string | null, listed: readonly ListedTournament[], opts: { link: boolean }): Promise<PlannedInput[]>;
  timeZone: string;
  now: () => Date;
}

/** Listing failures as decision 12 names them. */
function unreadCode(code: string): UnreadProfessor['code'] {
  if (code === 'needs_reconnect') return 'needs_reconnect';
  if (code === 'unavailable' || code === 'rate_limited') return 'upstream_unavailable';
  return 'refused';
}

/** A details failure after which play-tools isn't asked again in the same request. */
const STOPS_DETAILS: ReadonlySet<string> = new Set(['unavailable', 'rate_limited']);

/** A tournament's series as its details give it: null for a custom event. */
type DetailsSeries = { id: string; name: string | null } | null;

export function createRequiredEvents(deps: RequiredEventsDeps): RequiredEvents {
  /** connection|from|to → a listing read within the TTL. */
  const listingCache = new Map<string, { at: number; tournaments: readonly Tournament[] }>();
  /** The same key → the read in flight, shared by concurrent requests. */
  const listingInFlight = new Map<string, Promise<readonly Tournament[]>>();
  /** Bumped when listings are dropped, so a read already in flight doesn't put a stale one back. */
  let generation = 0;
  /** guid → its series, kept for good: a professor can't change a tournament's series. */
  const seriesCache = new Map<string, DetailsSeries>();
  /** guid → the details read in flight, shared by concurrent requests. */
  const detailsInFlight = new Map<string, Promise<DetailsSeries>>();
  /**
   * guid → when its details last failed for a reason a retry won't fix (refused, not found, an unexpected shape): not
   * asked again until the listings are next read, so the grid, banner and badge don't keep play-tools busy.
   */
  const detailsFailedAt = new Map<string, number>();

  function readListing(c: ActingConnection, range: { from: Date; to: Date }, refresh: boolean): Promise<readonly Tournament[]> {
    const key = `${c.id}|${range.from.toISOString()}|${range.to.toISOString()}`;
    const at = deps.now().getTime();
    // Drop what has expired, so ranges past months no longer ask for don't pile up.
    for (const [k, v] of listingCache) if (at - v.at >= LISTING_TTL_MS) listingCache.delete(k);
    const hit = listingCache.get(key);
    if (!refresh && hit) return Promise.resolve(hit.tournaments);
    const pending = listingInFlight.get(key);
    if (pending) return pending;
    const startedIn = generation;
    const read = deps
      .gateway(c.id)
      .listTournaments(range)
      .then((tournaments) => {
        if (startedIn === generation) listingCache.set(key, { at, tournaments });
        return tournaments;
      })
      .finally(() => {
        if (listingInFlight.get(key) === read) listingInFlight.delete(key);
      });
    listingInFlight.set(key, read);
    return read;
  }

  function readSeries(c: ActingConnection, guid: string): Promise<DetailsSeries> {
    const pending = detailsInFlight.get(guid);
    if (pending) return pending;
    const read = deps
      .gateway(c.id)
      .getTournament(guid)
      .then((t) => {
        seriesCache.set(guid, t.series);
        return t.series;
      })
      .finally(() => detailsInFlight.delete(guid));
    detailsInFlight.set(guid, read);
    return read;
  }

  /** The first connected professor's series list that can be read, or null. */
  async function seriesList(conns: readonly ActingConnection[], group: string): Promise<readonly Series[] | null> {
    for (const c of conns.filter((x) => x.status === 'connected')) {
      try {
        return await deps.live.series(c.id, group);
      } catch (err) {
        if (!(err instanceof PokemonUpstreamError)) throw err;
      }
    }
    return null;
  }

  return {
    listingsChanged() {
      generation++;
      listingCache.clear();
      listingInFlight.clear();
      detailsFailedAt.clear();
    },

    async read(leagueId, opts) {
      const now = deps.now();
      const today = dateIn(now, deps.timeZone) as LocalDate;
      const requirements = deps.requirements.active(leagueId);
      const conns = deps.connections.listActingConnections();
      const group = conns.length === 0 ? null : (deps.connections.getStatus(leagueId).league?.id ?? null);
      const upstream = conns.length === 0 ? 'not_connected' : group === null ? 'league_not_selected' : 'read';
      const base = { timeZone: deps.timeZone, today, country: COVERAGE_COUNTRY, upstream } as const;
      if (requirements.length === 0) return { ...base, unread: [], seriesUnavailable: false, requirements: [] };

      const periods = new Map(requirements.map((r) => [r.id, periodsFor(r.cadence, today)]));
      const all = [...periods.values()].flat();
      const from = all.reduce((a, p) => (p.start < a ? p.start : a), all[0]!.start);
      const to = all.reduce((a, p) => (p.end > a ? p.end : a), all[0]!.end);

      // Each connected professor's tournaments in the league (ADR-0009: they list only their own).
      const listed: ListedTournament[] = [];
      const unread: UnreadProfessor[] = [];
      if (group !== null) {
        const range = { from: localDay(from as SessionDate, deps.timeZone).from, to: localDay(to as SessionDate, deps.timeZone).to };
        const seen = new Set<string>();
        for (const c of conns) {
          const professor = { playerId: c.professorPlayerId, name: c.professorName };
          if (c.status === 'needs_reconnect') {
            unread.push({ professor, code: 'needs_reconnect', message: `Reconnect ${c.professorName ?? 'this professor'} in Settings to see their tournaments.` });
            continue;
          }
          try {
            for (const t of await readListing(c, range, opts.refresh)) {
              if (t.groupId !== group || t.startsAt === null || seen.has(t.id)) continue;
              seen.add(t.id);
              listed.push({ tournament: t, organizer: c });
            }
          } catch (err) {
            if (!(err instanceof PokemonUpstreamError)) throw err;
            unread.push({ professor, code: unreadCode(err.code), message: err.message });
          }
        }
      }

      // Series from details, one at a time, only for tournaments that could count; a 429 or 5xx stops the rest.
      const couldCount = (t: Tournament) => {
        if (classOf({ status: t.status, applicationState: t.applicationState ?? null }) === 'ignored') return false;
        const date = dateIn(t.startsAt!, deps.timeZone) as LocalDate;
        return requirements.some((r) => t.products.includes(r.product) && periods.get(r.id)!.some((p) => date >= p.start && date <= p.end));
      };
      let stopped = false;
      const seriesFor = new Map<string, ListedInput['series']>();
      for (const { tournament: t, organizer } of listed) {
        if (!couldCount(t)) continue;
        if (seriesCache.has(t.id)) {
          seriesFor.set(t.id, seriesCache.get(t.id)!);
          continue;
        }
        const failedAt = detailsFailedAt.get(t.id);
        if (stopped || (failedAt !== undefined && now.getTime() - failedAt < LISTING_TTL_MS)) {
          seriesFor.set(t.id, 'unread');
          continue;
        }
        try {
          seriesFor.set(t.id, await readSeries(organizer, t.id));
        } catch (err) {
          if (!(err instanceof PokemonUpstreamError)) throw err;
          seriesFor.set(t.id, 'unread');
          if (STOPS_DETAILS.has(err.code)) stopped = true;
          else detailsFailedAt.set(t.id, now.getTime());
        }
      }

      const list = group === null ? null : await seriesList(conns, group);
      const names = new Map((list ?? []).map((s) => [s.id, s.name]));
      // Linking `unknown` rows reads details too: after a 429 or 5xx it waits for the next request.
      const planned = await deps.planned(leagueId, to, group, listed, { link: !stopped });

      const result = coverage({
        today,
        timeZone: deps.timeZone,
        country: COVERAGE_COUNTRY,
        requirements,
        covers: deps.requirements.covers(leagueId),
        upstream,
        unread,
        series: list?.map((s): SeriesInput => ({ id: s.id, name: s.name, product: s.product, windows: s.windows })) ?? null,
        listed: listed.map(({ tournament: t, organizer }): ListedInput => {
          const read = seriesFor.get(t.id) ?? null;
          const name = read === null || read === 'unread' ? null : (read.name ?? names.get(read.id) ?? null);
          // A nameless series can only be named by the series list; without it, the tournament can't be judged.
          const series = read === null || read === 'unread' ? read : name === null && list === null ? 'unread' : { id: read.id, name };
          return {
            tournamentId: t.id,
            displayId: t.displayId,
            products: t.products,
            startsAt: t.startsAt!.toISOString(),
            status: t.status,
            applicationState: t.applicationState ?? null,
            series,
            organizer: { playerId: organizer.professorPlayerId!, name: organizer.professorName },
          };
        }),
        planned,
      });
      return {
        ...base,
        unread,
        seriesUnavailable: list === null,
        requirements: requirements.map((requirement, i) => ({ requirement, periods: result[i]!.periods })),
      };
    },
  };
}
