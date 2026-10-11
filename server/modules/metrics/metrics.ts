import { eq, sql } from 'drizzle-orm';
import type { Thresholds } from '../../../shared/schemas/settings';
import type { PlayerId, SessionDate } from '../../../shared/types/ids';
import type { Db } from '../../db/client';
import { curationSettings } from '../../db/schema';
import type { Player, Regular, RosterService } from '../roster/service';

export type { Thresholds };

export const DEFAULT_THRESHOLDS: Readonly<Thresholds> = { promoteMinSightings: 4, staleAfterSessions: 6 };

/**
 * Curation metrics for one player (architecture §5), computed on read from
 * sightings (ADR-0005). A league session was held on every date with any
 * sighting; dates after today are ignored.
 */
export interface PlayerMetrics {
  /** Distinct session dates with a sighting. */
  sightingsTotal: number;
  /** Distinct session dates with a sighting in the last 4, 8 and 12 weeks (today included). */
  sightings4w: number;
  sightings8w: number;
  sightings12w: number;
  /** `sightings8w` ÷ league sessions held in the last 8 weeks; null when none were held. */
  attendanceRate8w: number | null;
  firstSeen: SessionDate;
  lastSeen: SessionDate;
  /** Consecutive league sessions with a sighting, back from the latest. */
  currentStreak: number;
  /** League sessions held since `lastSeen`. */
  sessionsSinceLastSeen: number;
  /** League sessions held since the last tdf or manual sighting; null without one (stale regulars, §5). */
  sessionsSinceLastPresent: number | null;
}

/** Which players the Players page lists (architecture §8). */
export type CurationFilter = 'all' | 'promote' | 'stale';

export interface CuratedPlayer extends Player {
  /** Null when the player was never seen. */
  metrics: PlayerMetrics | null;
  /** Session dates submitted upstream for the player (audit only; says nothing about presence). */
  timesSubmitted: number;
  promotionCandidate: boolean;
  stale: boolean;
}

export interface RegularWithMetrics extends Regular {
  metrics: PlayerMetrics | null;
  timesSubmitted: number;
  stale: boolean;
}

export interface MetricsService {
  /** Metrics for every player with a sighting on or before `today`; players never seen are absent. */
  forLeague(leagueId: string, today: SessionDate): Map<PlayerId, PlayerMetrics>;
  /**
   * `all` by name; `promote` most seen in the last 8 weeks first; `stale`
   * never present first, then longest absent. Ties keep name order.
   */
  listPlayers(leagueId: string, opts: { filter: CurationFilter; q?: string; today: SessionDate }): CuratedPlayer[];
  /** Regulars by name, with metrics. */
  listRegulars(leagueId: string, today: SessionDate): RegularWithMetrics[];
  getThresholds(leagueId: string): Thresholds;
  setThresholds(leagueId: string, thresholds: Thresholds): Thresholds;
}

export interface MetricsDeps {
  db: Db;
  roster: Pick<RosterService, 'listPlayers' | 'listRegulars'>;
  /** Owned by the submission module: per player, how many session dates were submitted upstream. */
  submissions: { timesSubmitted(leagueId: string): Map<PlayerId, number> };
}

interface Row {
  player_id: string;
  sightings_total: number;
  sightings_4w: number;
  sightings_8w: number;
  sightings_12w: number;
  held_8w: number;
  first_seen: string;
  last_seen: string;
  current_streak: number;
  sessions_since_last_seen: number;
  sessions_since_last_present: number | null;
}

export function createMetricsService(deps: MetricsDeps): MetricsService {
  const { db, roster, submissions } = deps;

  function forLeague(leagueId: string, today: SessionDate): Map<PlayerId, PlayerMetrics> {
    const since = (weeks: number) => addDays(today, -7 * weeks);
    const rows = db.all<Row>(sql`
      -- One row per player and date; present when a tdf or manual sighting says they were there.
      with seen as (
        select player_id, session_date, max(kind in ('tdf', 'manual')) as present
        from sighting
        where league_id = ${leagueId} and session_date <= ${today}
        group by player_id, session_date
      ),
      -- A league session was held on every date with any sighting; rank 1 is the latest.
      held as (
        select session_date, row_number() over (order by session_date desc) as rank
        from (select distinct session_date from seen)
      ),
      per_player as (
        select
          player_id,
          count(*) as sightings_total,
          sum(case when session_date > ${since(4)} then 1 else 0 end) as sightings_4w,
          sum(case when session_date > ${since(8)} then 1 else 0 end) as sightings_8w,
          sum(case when session_date > ${since(12)} then 1 else 0 end) as sightings_12w,
          min(session_date) as first_seen,
          max(session_date) as last_seen,
          max(case when present then session_date end) as last_present
        from seen
        group by player_id
      ),
      -- The latest session each player missed.
      missed as (
        select p.player_id, min(h.rank) as rank
        from per_player p
        cross join held h
        left join seen s on s.player_id = p.player_id and s.session_date = h.session_date
        where s.player_id is null
        group by p.player_id
      )
      select
        p.*,
        (select count(*) from held where session_date > ${since(8)}) as held_8w,
        coalesce(m.rank, (select count(*) + 1 from held)) - 1 as current_streak,
        (select count(*) from held where session_date > p.last_seen) as sessions_since_last_seen,
        case when p.last_present is not null
          then (select count(*) from held where session_date > p.last_present)
        end as sessions_since_last_present
      from per_player p
      left join missed m on m.player_id = p.player_id
    `);
    return new Map(
      rows.map((r) => [
        r.player_id as PlayerId,
        {
          sightingsTotal: r.sightings_total,
          sightings4w: r.sightings_4w,
          sightings8w: r.sightings_8w,
          sightings12w: r.sightings_12w,
          attendanceRate8w: r.held_8w > 0 ? r.sightings_8w / r.held_8w : null,
          firstSeen: r.first_seen as SessionDate,
          lastSeen: r.last_seen as SessionDate,
          currentStreak: r.current_streak,
          sessionsSinceLastSeen: r.sessions_since_last_seen,
          sessionsSinceLastPresent: r.sessions_since_last_present,
        },
      ]),
    );
  }

  const sessionsHeld = (leagueId: string, today: SessionDate) =>
    db.get<{ n: number }>(sql`
      select count(distinct session_date) as n from sighting where league_id = ${leagueId} and session_date <= ${today}
    `)!.n;

  /** Metrics and flags for players of one league, as of `today`. */
  function curator(leagueId: string, today: SessionDate) {
    const { promoteMinSightings, staleAfterSessions } = getThresholds(leagueId);
    const seen = forLeague(leagueId, today);
    const submitted = submissions.timesSubmitted(leagueId);
    // "No tdf or manual sighting in the last N sessions" needs N sessions to have been held.
    const enoughSessions = sessionsHeld(leagueId, today) >= staleAfterSessions;

    return (p: { playerId: PlayerId; isRegular: boolean }) => {
      const metrics = seen.get(p.playerId) ?? null;
      return {
        metrics,
        timesSubmitted: submitted.get(p.playerId) ?? 0,
        promotionCandidate: !p.isRegular && (metrics?.sightings8w ?? 0) >= promoteMinSightings,
        stale: p.isRegular && enoughSessions && absence(metrics) >= staleAfterSessions,
      };
    };
  }

  function getThresholds(leagueId: string): Thresholds {
    const row = db
      .select({ promoteMinSightings: curationSettings.promoteMinSightings, staleAfterSessions: curationSettings.staleAfterSessions })
      .from(curationSettings)
      .where(eq(curationSettings.leagueId, leagueId))
      .get();
    return row ?? { ...DEFAULT_THRESHOLDS };
  }

  return {
    forLeague,
    getThresholds,

    setThresholds(leagueId, thresholds) {
      const { promoteMinSightings, staleAfterSessions } = thresholds;
      db.insert(curationSettings)
        .values({ leagueId, promoteMinSightings, staleAfterSessions })
        .onConflictDoUpdate({ target: curationSettings.leagueId, set: { promoteMinSightings, staleAfterSessions } })
        .run();
      return { promoteMinSightings, staleAfterSessions };
    },

    listPlayers(leagueId, { filter, q, today }) {
      const curate = curator(leagueId, today);
      const players = roster.listPlayers(leagueId, { q }).map((p) => ({ ...p, ...curate(p) }));

      // Array.prototype.sort is stable, so the roster's name order breaks ties.
      if (filter === 'promote') {
        return players.filter((p) => p.promotionCandidate).sort((a, b) => b.metrics!.sightings8w - a.metrics!.sightings8w);
      }
      if (filter === 'stale') {
        return players.filter((p) => p.stale).sort((a, b) => compareDesc(absence(a.metrics), absence(b.metrics)));
      }
      return players;
    },

    listRegulars(leagueId, today) {
      const curate = curator(leagueId, today);
      return roster.listRegulars(leagueId).map((r) => {
        const { metrics, timesSubmitted, stale } = curate({ ...r, isRegular: true });
        return { ...r, metrics, timesSubmitted, stale };
      });
    },
  };
}

/** Sessions since the player was last present; never present is forever. */
function absence(m: PlayerMetrics | null): number {
  return m?.sessionsSinceLastPresent ?? Infinity;
}

/** Descending; unlike `b - a`, safe for Infinity. */
function compareDesc(a: number, b: number): number {
  return a === b ? 0 : a > b ? -1 : 1;
}

/** `YYYY-MM-DD` plus `days`, as calendar arithmetic (no timezone involved). */
function addDays(date: SessionDate, days: number): SessionDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10) as SessionDate;
}
