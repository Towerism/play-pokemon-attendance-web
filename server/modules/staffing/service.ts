import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { PlayerId, SessionDate } from '../../../shared/types/ids';
import type { Db } from '../../db/client';
import { staffAssignment, staffHistory } from '../../db/schema';
import type { PokemonConnectionService } from '../pokemon/connection';
import { PokemonUpstreamError } from '../pokemon/ports/errors';
import type {
  PlayToolsGateway,
  Tournament,
  TournamentDetails,
  TournamentParticipant,
} from '../pokemon/ports/play-tools-gateway';
import type { RosterService } from '../roster/service';
import { dateIn, localDay } from '../submission/local-time';
import { StaffingError } from './errors';

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

export type AssignmentState = 'pending' | 'assigned' | 'failed' | 'removing';

export interface StaffAssignmentView {
  id: number;
  playerId: PlayerId;
  /** The local name. */
  name: string;
  /** The wanted role. */
  role: string;
  /** The role play-tools holds while it differs from `role`; the staff job changes it. */
  appliedRole: string | null;
  state: AssignmentState;
}

/** One tournament on the This week Staff card. */
export interface TournamentStaffView {
  tournamentId: string;
  label: string;
  /** ISO; null for a tournament play-tools no longer lists. */
  startsAt: string | null;
  editable: boolean;
  /** Play-tools no longer lists it (cancelled or deleted): its assignments stay visible. */
  missing?: true;
  organizer: { playerId: PlayerId } | null;
  assignments: StaffAssignmentView[];
  /** Staff play-tools lists that none of this league's assignments holds. */
  upstreamOnly: { playerId: PlayerId; name: string; role: string }[];
  /** Everyone listed as a player (not staff), ids only. */
  players: { playerId: PlayerId }[];
}

export interface SessionStaff {
  timeZone: string;
  tournaments: TournamentStaffView[];
}

export interface AddStaff {
  tournamentId: string;
  playerId: PlayerId;
  role: string;
  /** Names a player the app can't name yet; never renames one. */
  name?: string;
}

export interface StaffingService {
  /** The roles play-tools offers staff, judge first; never `organizer`. No upstream call. */
  listRoles(leagueId: string): readonly { code: string; label: string }[];
  /**
   * Changes the wanted role. For an assignment play-tools already holds, the
   * staff job sends the change; until then `appliedRole` keeps the old role.
   * @throws StaffingError `not_found`, `unknown_role`, `tournament_locked`
   */
  changeRole(leagueId: string, date: SessionDate, assignmentId: number, role: string): Promise<StaffAssignmentView>;
  /**
   * Deletes an assignment that never reached play-tools; tombstones one that
   * did, for the staff job to delete upstream.
   * @throws StaffingError `not_found`, `tournament_locked`
   */
  removeAssignment(leagueId: string, date: SessionDate, assignmentId: number): Promise<void>;
  /**
   * Adds (or revives) the wanted staffer for one of the date's tournaments.
   * `created` is false when they were already wanted there in that role.
   * @throws StaffingError, PokemonUpstreamError
   */
  addAssignment(leagueId: string, date: SessionDate, input: AddStaff, by: string): Promise<{ created: boolean; assignment: StaffAssignmentView }>;
  /**
   * The date's tournaments (this league's, read live, in start order) with
   * their staff, after seeding the staff list from what was read.
   * @throws StaffingError `league_not_selected`, PokemonUpstreamError
   */
  sessionStaff(leagueId: string, date: SessionDate): Promise<SessionStaff>;
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

/** The play-tools calls staffing makes. */
export type StaffGateway = Pick<
  PlayToolsGateway,
  'listTournaments' | 'getTournament' | 'listTournamentParticipants' | 'listStaffRoles'
>;

export interface StaffingDeps {
  db: Db;
  roster: RosterService;
  connections: Pick<PokemonConnectionService, 'getStatus'>;
  gateway: (leagueId: string) => StaffGateway;
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

function recordUpstreamStaff(leagueId: string, tournament: SeedTournament, participants: readonly TournamentParticipant[]): PlayerId[] {
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
  }

  /** The selected league's activity group: tournaments of other groups aren't this league's. */
  function leagueGroup(leagueId: string): string {
    const c = deps.connections.getStatus(leagueId);
    if (c.status === 'not_connected') {
      throw new PokemonUpstreamError('not_connected', 'No Pokémon account is connected. Connect one in Settings.');
    }
    if (c.status === 'needs_reconnect') {
      throw new PokemonUpstreamError('needs_reconnect', c.reason ?? 'Reconnect the Pokémon account in Settings.');
    }
    if (!c.league) throw new StaffingError('league_not_selected', 'Choose the league in Settings first.');
    return c.league.id;
  }

  /** This league's tournaments starting on the date in the league timezone, by start. */
  async function tournamentsOn(leagueId: string, date: SessionDate): Promise<Tournament[]> {
    const groupId = leagueGroup(leagueId);
    const listed = await deps.gateway(leagueId).listTournaments(localDay(date, timeZone));
    return listed
      .filter((t) => t.groupId === groupId)
      .sort((a, b) => (a.startsAt?.getTime() ?? 0) - (b.startsAt?.getTime() ?? 0));
  }

  /** Details and participants, or null when play-tools no longer has the tournament. */
  async function readTournament(leagueId: string, tournamentId: string) {
    const gateway = deps.gateway(leagueId);
    let details: TournamentDetails;
    try {
      details = await gateway.getTournament(tournamentId);
    } catch (err) {
      if (err instanceof PokemonUpstreamError && err.code === 'not_found') return null;
      throw err;
    }
    const participants = await gateway.listTournamentParticipants(tournamentId);
    return { details, participants };
  }

  const isEditable = (t: Pick<Tournament, 'editableUntil'>) => t.editableUntil !== null && now() < t.editableUntil;

  function assignmentsOn(leagueId: string, date: SessionDate) {
    return db
      .select()
      .from(staffAssignment)
      .where(and(eq(staffAssignment.leagueId, leagueId), eq(staffAssignment.sessionDate, date)))
      .orderBy(asc(staffAssignment.id))
      .all();
  }

  function namesOf(leagueId: string, playerIds: readonly PlayerId[]): Map<string, string> {
    return new Map(roster.getPlayers(leagueId, [...new Set(playerIds)]).map((p) => [p.playerId, p.displayName]));
  }

  type AssignmentRow = ReturnType<typeof assignmentsOn>[number];
  const toView = (row: AssignmentRow, names: Map<string, string>): StaffAssignmentView => ({
    id: row.id,
    playerId: row.playerId as PlayerId,
    name: names.get(row.playerId) ?? '',
    role: row.role,
    appliedRole: row.appliedRole,
    state: row.removedAt ? 'removing' : row.state,
  });

  function assertRole(leagueId: string, role: string) {
    if (!deps.gateway(leagueId).listStaffRoles().some((r) => r.code === role)) {
      throw new StaffingError('unknown_role', `"${role}" is not a staff role play-tools offers.`);
    }
  }

  /** One of the date's tournaments for this league, read fresh, or `unknown_tournament`. */
  async function freshTournament(leagueId: string, date: SessionDate, tournamentId: string) {
    const tournament = (await tournamentsOn(leagueId, date)).find((t) => t.id === tournamentId);
    const read = tournament && (await readTournament(leagueId, tournamentId));
    if (!tournament || !read) {
      throw new StaffingError('unknown_tournament', `Tournament ${tournamentId} is not one of this league's tournaments on ${date}.`);
    }
    return { tournament, ...read };
  }

  function assertEditable(tournament: Tournament) {
    if (!isEditable(tournament)) {
      throw new StaffingError('tournament_locked', 'This tournament is past its edit window; play-tools no longer accepts staff changes.');
    }
  }

  const liveAssignment = (leagueId: string, tournamentId: string, playerId: string) =>
    db
      .select()
      .from(staffAssignment)
      .where(
        and(
          eq(staffAssignment.leagueId, leagueId),
          eq(staffAssignment.tournamentId, tournamentId),
          eq(staffAssignment.playerId, playerId),
          isNull(staffAssignment.removedAt),
        ),
      )
      .get();

  const tombstoned = (leagueId: string, tournamentId: string, playerId: string) =>
    db
      .select()
      .from(staffAssignment)
      .where(
        and(
          eq(staffAssignment.leagueId, leagueId),
          eq(staffAssignment.tournamentId, tournamentId),
          eq(staffAssignment.playerId, playerId),
          isNotNull(staffAssignment.removedAt),
        ),
      )
      .orderBy(desc(staffAssignment.id))
      .get();

  function viewOf(leagueId: string, row: AssignmentRow): StaffAssignmentView {
    return toView(row, namesOf(leagueId, [row.playerId as PlayerId]));
  }

  /** The answer for a player already wanted on the tournament: same role is a repeat, another role a conflict. */
  function existing(leagueId: string, row: AssignmentRow, role: string) {
    if (row.role !== role) {
      throw new StaffingError('player_already_staffed', `Player ${row.playerId} is already wanted on this tournament as ${row.role}.`);
    }
    return { created: false, assignment: viewOf(leagueId, row) };
  }

  function liveOn(leagueId: string, date: SessionDate, assignmentId: number): AssignmentRow {
    const row = db
      .select()
      .from(staffAssignment)
      .where(
        and(
          eq(staffAssignment.id, assignmentId),
          eq(staffAssignment.leagueId, leagueId),
          eq(staffAssignment.sessionDate, date),
          isNull(staffAssignment.removedAt),
        ),
      )
      .get();
    if (!row) throw new StaffingError('not_found', `No staff assignment ${assignmentId} on ${date}.`);
    return row;
  }

  /** An applied change needs the tournament still open upstream; `orMissing` also accepts one play-tools no longer lists. */
  async function assertStillEditable(leagueId: string, date: SessionDate, tournamentId: string, orMissing: boolean) {
    const tournament = (await tournamentsOn(leagueId, date)).find((t) => t.id === tournamentId);
    if (!tournament && orMissing) return;
    if (!tournament) {
      throw new StaffingError('tournament_locked', 'Play-tools no longer lists this tournament; its staff can no longer change.');
    }
    assertEditable(tournament);
  }

  return {
    listRoles: (leagueId) => deps.gateway(leagueId).listStaffRoles(),

    async changeRole(leagueId, date, assignmentId, role) {
      const row = liveOn(leagueId, date, assignmentId);
      assertRole(leagueId, role);
      if (row.role === role) return viewOf(leagueId, row);
      let appliedRole: string | null = null;
      if (row.recordId) {
        await assertStillEditable(leagueId, date, row.tournamentId, false);
        const heldUpstream = row.appliedRole ?? row.role;
        appliedRole = heldUpstream === role ? null : heldUpstream;
      }
      const updated = db
        .update(staffAssignment)
        .set({ role, appliedRole })
        .where(and(eq(staffAssignment.id, row.id), isNull(staffAssignment.removedAt)))
        .returning()
        .get();
      if (!updated) throw new StaffingError('not_found', `No staff assignment ${assignmentId} on ${date}.`);
      return viewOf(leagueId, updated);
    },

    async removeAssignment(leagueId, date, assignmentId) {
      const row = liveOn(leagueId, date, assignmentId);
      if (!row.recordId) {
        db.delete(staffAssignment).where(eq(staffAssignment.id, row.id)).run();
        return;
      }
      await assertStillEditable(leagueId, date, row.tournamentId, true);
      db.update(staffAssignment)
        .set({ removedAt: now(), state: 'removing' })
        .where(and(eq(staffAssignment.id, row.id), isNull(staffAssignment.removedAt)))
        .run();
    },

    async addAssignment(leagueId, date, input, by) {
      assertRole(leagueId, input.role);
      const live = liveAssignment(leagueId, input.tournamentId, input.playerId);
      if (live) return existing(leagueId, live, input.role);

      const { tournament, details, participants } = await freshTournament(leagueId, date, input.tournamentId);
      assertEditable(tournament);
      if (input.playerId === details.organizerPlayerId) {
        throw new StaffingError('organizer_cannot_staff', "A tournament's organizer can't be its staff.");
      }
      const revive = tombstoned(leagueId, input.tournamentId, input.playerId);
      const ownRecord = participants.find((p) => revive?.recordId && p.recordId === revive.recordId);
      const listed = participants.find((p) => p.playerId === input.playerId && p !== ownRecord);
      if (listed) {
        throw new StaffingError('already_listed', `Play-tools already lists player ${input.playerId} on this tournament.`, {
          how: listed.isStaff ? 'staff' : 'player',
        });
      }

      return db.transaction(() => {
        recordUpstreamStaff(leagueId, details, participants);
        roster.ensurePlayers(leagueId, [{ playerId: input.playerId, ...(input.name ? { name: input.name } : {}) }]);
        if (revive) {
          const heldUpstream = ownRecord?.role ?? revive.appliedRole ?? revive.role;
          const row = db
            .update(staffAssignment)
            .set({ role: input.role, appliedRole: heldUpstream === input.role ? null : heldUpstream, state: 'assigned', removedAt: null })
            .where(eq(staffAssignment.id, revive.id))
            .returning()
            .get();
          return { created: true, assignment: viewOf(leagueId, row) };
        }
        try {
          const row = db
            .insert(staffAssignment)
            .values({
              leagueId,
              sessionDate: date,
              tournamentId: input.tournamentId,
              tournamentLabel: labelOf(tournament),
              playerId: input.playerId,
              role: input.role,
              createdBy: by,
              createdAt: now(),
            })
            .returning()
            .get();
          return { created: true, assignment: viewOf(leagueId, row) };
        } catch (err) {
          // A concurrent add of the same player won the unique index.
          const winner = liveAssignment(leagueId, input.tournamentId, input.playerId);
          if (winner) return existing(leagueId, winner, input.role);
          throw err;
        }
      });
    },

    async sessionStaff(leagueId, date) {
      const listed = await tournamentsOn(leagueId, date);
      const reads: { tournament: Tournament; details: TournamentDetails; participants: TournamentParticipant[] }[] = [];
      for (const tournament of listed) {
        const read = await readTournament(leagueId, tournament.id);
        if (!read) continue;
        recordUpstreamStaff(leagueId, read.details, read.participants);
        reads.push({ tournament, ...read });
      }

      const rows = assignmentsOn(leagueId, date);
      const upstreamStaff = reads.flatMap((r) => r.participants.filter((p) => p.isStaff));
      const names = namesOf(leagueId, [...rows.map((r) => r.playerId as PlayerId), ...upstreamStaff.map((p) => p.playerId)]);

      const tournaments: TournamentStaffView[] = reads.map(({ tournament, details, participants }) => {
        const ours = rows.filter((r) => r.tournamentId === tournament.id);
        const ourRecords = new Set(ours.map((r) => r.recordId).filter(Boolean));
        return {
          tournamentId: tournament.id,
          label: labelOf(tournament),
          startsAt: tournament.startsAt?.toISOString() ?? null,
          editable: isEditable(tournament),
          organizer: { playerId: details.organizerPlayerId },
          assignments: ours.map((r) => toView(r, names)),
          upstreamOnly: participants
            .filter((p) => p.isStaff && p.role !== 'organizer' && p.playerId !== details.organizerPlayerId && !ourRecords.has(p.recordId))
            .map((p) => ({ playerId: p.playerId, name: names.get(p.playerId) || p.name, role: p.role ?? '' })),
          players: participants.filter((p) => !p.isStaff).map((p) => ({ playerId: p.playerId })),
        };
      });

      const shown = new Set(reads.map((r) => r.tournament.id));
      const missing = new Map<string, AssignmentRow[]>();
      for (const row of rows.filter((r) => !shown.has(r.tournamentId))) {
        missing.set(row.tournamentId, [...(missing.get(row.tournamentId) ?? []), row]);
      }
      for (const [tournamentId, group] of missing) {
        tournaments.push({
          tournamentId,
          label: group[0]!.tournamentLabel,
          startsAt: null,
          editable: false,
          missing: true,
          organizer: null,
          assignments: group.map((r) => toView(r, names)),
          upstreamOnly: [],
          players: [],
        });
      }
      return { timeZone, tournaments };
    },

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

    recordUpstreamStaff,

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

/** `name · display id`, from whichever parts play-tools has; the guid when it has neither. */
function labelOf(t: Pick<Tournament, 'id' | 'name' | 'displayId'>): string {
  return [t.name, t.displayId].filter(Boolean).join(' · ') || t.id;
}
