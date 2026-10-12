import { sql } from 'drizzle-orm';
import type { PlayerId, SessionDate } from '../../../shared/types/ids';
import type { Db } from '../../db/client';
import { staffHistory } from '../../db/schema';
import type { TournamentParticipant } from '../pokemon/ports/play-tools-gateway';
import type { RosterService } from '../roster/service';
import { dateIn } from '../submission/local-time';

/** A tournament as seeding needs it: its start (null when play-tools has none) and its organizer. */
export interface SeedTournament {
  id: string;
  startsAt: Date | null;
  organizerPlayerId: PlayerId;
}

/** A staffer this app applied (or adopted) upstream, for the staff list. */
export interface AppStaffRow {
  tournamentId: string;
  playerId: PlayerId;
  role: string;
  tournamentDate: SessionDate | null;
}

/** One person on the staff list (`GET /staff`). `name` is always the local name. */
export interface StaffListEntry {
  playerId: PlayerId;
  name: string;
  timesStaffed: number;
  /** Null when none of their tournaments has a start date. */
  lastStaffedOn: SessionDate | null;
  /** The upstream role as text: possibly one the app doesn't offer. */
  lastRole: string;
}

export interface StaffingService {
  /** The staff list: most recently staffed first, then most often; `q` matches part of a name or player id. */
  searchStaff(leagueId: string, opts: { q?: string; limit?: number }): StaffListEntry[];
  /**
   * Seeds the staff list from one read of a tournament's participants
   * (ADR-0007 decisions 5 and 13): every staff record except the organizer's
   * becomes a known player (the play-tools name only fills a missing one) and
   * a `staff_history` row. Returns the players the league didn't know before.
   */
  recordUpstreamStaff(leagueId: string, tournament: SeedTournament, participants: readonly TournamentParticipant[]): PlayerId[];
  /** Records staffers this app applied or adopted upstream (`source = app`, which then sticks). */
  recordAppStaff(leagueId: string, rows: readonly AppStaffRow[]): void;
}

export interface StaffingDeps {
  db: Db;
  roster: RosterService;
  /** The league timezone (ADR-0006): tournament dates are read in it. */
  timeZone: string;
  now?: () => Date;
}

export function createStaffingService(deps: StaffingDeps): StaffingService {
  const { db, roster, timeZone } = deps;
  const now = deps.now ?? (() => new Date());

  function upsertHistory(leagueId: string, rows: readonly AppStaffRow[], source: 'app' | 'upstream') {
    if (rows.length === 0) return;
    db.insert(staffHistory)
      .values(rows.map((r) => ({ leagueId, ...r, source, recordedAt: now() })))
      .onConflictDoUpdate({
        target: [staffHistory.leagueId, staffHistory.tournamentId, staffHistory.playerId],
        set: {
          role: sql`excluded.role`,
          tournamentDate: sql`excluded.tournament_date`,
          recordedAt: sql`excluded.recorded_at`,
          // Once the app applied it, it stays the app's.
          source: sql`case when ${staffHistory.source} = 'app' then 'app' else excluded.source end`,
        },
      })
      .run();
  }

  return {
    searchStaff(leagueId, { q, limit } = {}) {
      const pattern = q && `%${escapeLike(q.toLowerCase())}%`;
      const search = pattern
        ? sql`and (lower(p.display_name) like ${pattern} escape '\\' or p.player_id like ${pattern} escape '\\')`
        : sql``;
      return db.all<StaffListEntry>(sql`
        select s.player_id as playerId, p.display_name as name, s.times as timesStaffed,
               s.last_on as lastStaffedOn, s.last_role as lastRole
        from (
          select h.player_id, count(*) as times, max(h.tournament_date) as last_on,
                 (select h2.role from ${staffHistory} h2
                   where h2.league_id = h.league_id and h2.player_id = h.player_id
                   order by h2.tournament_date is null, h2.tournament_date desc, h2.recorded_at desc
                   limit 1) as last_role
          from ${staffHistory} h
          where h.league_id = ${leagueId}
          group by h.league_id, h.player_id
        ) s
        join player p on p.player_id = s.player_id
        where 1 = 1 ${search}
        order by s.last_on is null, s.last_on desc, s.times desc, lower(p.display_name), p.player_id
        ${limit ? sql`limit ${limit}` : sql``}
      `);
    },

    recordUpstreamStaff(leagueId, tournament, participants) {
      const staff = participants.filter(
        (p) => p.isStaff && p.role !== null && p.role !== 'organizer' && p.playerId !== tournament.organizerPlayerId,
      );
      if (staff.length === 0) return [];
      const tournamentDate = tournament.startsAt ? dateIn(tournament.startsAt, timeZone) : null;
      return db.transaction(() => {
        const known = new Set(roster.getPlayers(leagueId, staff.map((s) => s.playerId)).map((p) => p.playerId));
        roster.ensurePlayers(leagueId, staff.map((s) => ({ playerId: s.playerId, ...(s.name ? { name: s.name } : {}) })));
        upsertHistory(
          leagueId,
          staff.map((s) => ({ tournamentId: tournament.id, playerId: s.playerId, role: s.role!, tournamentDate })),
          'upstream',
        );
        return [...new Set(staff.map((s) => s.playerId))].filter((id) => !known.has(id));
      });
    },

    recordAppStaff(leagueId, rows) {
      if (rows.length === 0) return;
      db.transaction(() => {
        roster.ensurePlayers(leagueId, rows.map((r) => ({ playerId: r.playerId })));
        upsertHistory(leagueId, rows, 'app');
      });
    },
  };
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
