import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { PlayerId, SessionDate } from '../../../shared/types/ids';
import type { Db } from '../../db/client';
import { staffAssignment, staffHistory } from '../../db/schema';
import type { ActingConnection, PokemonConnectionService } from '../pokemon/connection';
import { PokemonUpstreamError } from '../pokemon/ports/errors';
import type {
  PlayToolsGateway,
  Tournament,
  TournamentDetails,
  TournamentParticipant,
} from '../pokemon/ports/play-tools-gateway';
import type { RosterService } from '../roster/service';
import { dateIn, localDay } from '../../../shared/time/local-time';
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

/** A tournament's organizer, and whether the app can act as them (#75): only they may log its staff. */
export interface OrganizerView {
  playerId: PlayerId;
  /** Their display name in this app, when they are a connected professor who has one. */
  name: string | null;
  /** A connected professor with exactly this player id whose login works. */
  connected: boolean;
  /** A connected professor with exactly this player id whose login needs a reconnect. */
  needsReconnect: boolean;
}

/** One tournament on the This week Staff card. */
export interface TournamentStaffView {
  tournamentId: string;
  label: string;
  /** ISO; null for a tournament play-tools no longer lists. */
  startsAt: string | null;
  /** False past the edit window, or when the organizer can't act. */
  editable: boolean;
  /** Play-tools no longer lists it (cancelled or deleted): its live assignments stay visible, tombstones don't (#148). */
  missing?: true;
  /** Nobody listed it, but a professor couldn't be read, so it may be theirs: read-only. */
  unavailable?: true;
  /** Null for a missing or unavailable tournament. */
  organizer: OrganizerView | null;
  assignments: StaffAssignmentView[];
  /** Staff play-tools lists that none of this league's assignments holds. */
  upstreamOnly: { playerId: PlayerId; name: string; role: string }[];
  /** Everyone listed as a player (not staff), ids only. */
  players: { playerId: PlayerId }[];
}

/** A professor whose tournaments couldn't be read this time (#75). */
export interface UnreadProfessor {
  professor: { playerId: string | null; name: string | null };
  /** A `PokemonErrorCode`: needs_reconnect, unavailable, rate_limited, forbidden… */
  code: string;
  message: string;
}

export interface SessionStaff {
  timeZone: string;
  tournaments: TournamentStaffView[];
  /** Professors whose tournaments couldn't be read; everyone else's still show. */
  unread: UnreadProfessor[];
}

/** How reading one connected professor's tournaments went: read only when every call for them succeeded. */
export type ProfessorReadOutcome = { status: 'read' } | { status: 'unread'; code: string };

/** The date as an integration sees it (#115): only tournaments play-tools returned, with live assignments. */
export interface DaySnapshot {
  timeZone: string;
  /** In start order; each tournament once, however many professors list it. */
  tournaments: {
    tournament: Tournament;
    organizerPlayerId: PlayerId;
    /** Live (not tombstoned) assignments, oldest first, with local names and the wanted role. */
    staff: { playerId: PlayerId; name: string; role: string }[];
  }[];
  /** Every connected professor, in connection order. */
  professors: { connectionId: number; outcome: ProfessorReadOutcome }[];
}

/** The professor a staff job for a tournament runs as: always its organizer (#75). */
export interface ActingProfessor {
  connectionId: number;
  playerId: string;
  name: string | null;
}

export interface AddStaff {
  tournamentId: string;
  playerId: PlayerId;
  role: string;
  /** Names a player the app can't name yet; never renames one. */
  name?: string;
}

/** A staff assignment as the staff job sees it: the wanted role and the record this app holds (created or adopted). */
export interface StaffAssignmentRecord {
  id: number;
  playerId: PlayerId;
  role: string;
  appliedRole: string | null;
  recordId: string | null;
  /** Tombstoned: the staff job deletes `recordId`. */
  removed: boolean;
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
   * The date's tournaments (this league's, read live as each connected
   * professor, in start order) with their staff, after seeding the staff list
   * from what was read. A professor who can't be read is named in `unread`.
   * @throws StaffingError `league_not_selected`, PokemonUpstreamError `not_connected`
   */
  sessionStaff(leagueId: string, date: SessionDate): Promise<SessionStaff>;
  /**
   * The same reads as `sessionStaff` (seeding included), as domain values: the tournaments play-tools
   * returned and how each connected professor's read went (#115).
   * @throws StaffingError `league_not_selected`, PokemonUpstreamError `not_connected`
   */
  daySnapshot(leagueId: string, date: SessionDate): Promise<DaySnapshot>;
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
  /**
   * Checks a staff job may start for one of the date's tournaments (read fresh)
   * and returns its label and the organizer it must run as.
   * @throws StaffingError `unknown_tournament`, `tournament_locked`, `nothing_to_apply`, `unknown_role`, `league_not_selected`,
   *   `organizer_not_connected`, `needs_reconnect`; PokemonUpstreamError
   */
  prepareApply(leagueId: string, date: SessionDate, tournamentId: string): Promise<{ tournamentId: string; label: string; professor: ActingProfessor }>;
  /** The tournament's assignments, live and tombstoned, oldest first. */
  assignmentsFor(leagueId: string, tournamentId: string): StaffAssignmentRecord[];
  /**
   * Play-tools holds `recordId` for the assignment in `role`: it is `assigned`,
   * and the staffer joins the staff list as the app's. A no-op for an
   * assignment deleted or tombstoned meanwhile.
   */
  recordApplied(leagueId: string, assignmentId: number, applied: { recordId: string; role: string }): void;
  /** The staff job could not apply a live assignment. */
  recordFailed(leagueId: string, assignmentId: number): void;
  /** Play-tools no longer holds a tombstoned assignment's record: the row goes. Never deletes a live one. */
  forgetRemoved(leagueId: string, assignmentId: number): void;
  /**
   * A tournament rescheduled in place keeps its staff (ADR-0010 decision 8): its assignments, tombstones too, move
   * to its new local date. Nothing is sent. Returns how many moved.
   */
  moveTournament(leagueId: string, tournamentId: string, to: SessionDate): number;
  /**
   * A cancelled tournament keeps no wanted staff (ADR-0010 decision 8): assignments that never reached play-tools are
   * deleted, the rest tombstoned as `removeAssignment` does. Nothing is sent. Returns how many of each.
   */
  cancelTournament(leagueId: string, tournamentId: string): { dropped: number; removed: number };
}

/** The play-tools calls staffing makes. */
export type StaffGateway = Pick<
  PlayToolsGateway,
  'listTournaments' | 'getTournament' | 'listTournamentParticipants' | 'listStaffRoles'
>;

export interface StaffingDeps {
  db: Db;
  roster: RosterService;
  connections: Pick<PokemonConnectionService, 'getStatus' | 'listActingConnections'>;
  /** Play-tools as one professor's connection; `null` serves only the role list, which makes no call. */
  staffGateway: (connectionId: number | null) => StaffGateway;
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

  const roles = () => deps.staffGateway(null).listStaffRoles();
  const acting = () => deps.connections.listActingConnections();
  const professorOf = (c: ActingConnection) => ({ playerId: c.professorPlayerId, name: c.professorName });
  const byStart = (a: { startsAt: Date | null }, b: { startsAt: Date | null }) => (a.startsAt?.getTime() ?? 0) - (b.startsAt?.getTime() ?? 0);

  /**
   * The league's activity group: tournaments of other groups aren't this league's. Only the league
   * choice matters here, not whether the professor who submits attendance can act (#75).
   */
  function leagueGroup(leagueId: string): string {
    if (acting().length === 0) {
      throw new PokemonUpstreamError('not_connected', 'No Pokémon account is connected. Connect one in Settings.');
    }
    const c = deps.connections.getStatus(leagueId);
    if (!c.league) throw new StaffingError('league_not_selected', 'Choose the league in Settings first.');
    return c.league.id;
  }

  /** The connected professor with exactly this player id. */
  function organizerOf(organizerPlayerId: PlayerId, conns: readonly ActingConnection[]): OrganizerView {
    const owner = conns.find((c) => c.professorPlayerId !== null && c.professorPlayerId === organizerPlayerId);
    return {
      playerId: organizerPlayerId,
      name: owner?.professorName ?? null,
      connected: owner?.status === 'connected',
      needsReconnect: owner?.status === 'needs_reconnect',
    };
  }

  /** The connection to act on a tournament as: its organizer's, and only theirs (#75). */
  function actingAs(organizerPlayerId: PlayerId, conns: readonly ActingConnection[]): ActingConnection {
    const owner = conns.find((c) => c.professorPlayerId !== null && c.professorPlayerId === organizerPlayerId);
    if (!owner) {
      throw new StaffingError(
        'organizer_not_connected',
        `Only the tournament's organizer may log its staff. Connect Professor ${organizerPlayerId}'s Pokémon account in Settings.`,
        { organizerPlayerId },
      );
    }
    if (owner.status === 'needs_reconnect') {
      throw new StaffingError('needs_reconnect', `Reconnect ${owner.professorName ?? `Professor ${organizerPlayerId}`} in Settings to log staff on their tournament.`, {
        professorPlayerId: organizerPlayerId,
      });
    }
    return owner;
  }

  const startsOn = (t: Pick<Tournament, 'startsAt'>, date: SessionDate) => {
    const day = localDay(date, timeZone);
    return t.startsAt !== null && t.startsAt >= day.from && t.startsAt < day.to;
  };

  /** Details, or null when play-tools no longer has the tournament. */
  async function detailsOf(gateway: StaffGateway, tournamentId: string): Promise<TournamentDetails | null> {
    try {
      return await gateway.getTournament(tournamentId);
    } catch (err) {
      if (err instanceof PokemonUpstreamError && err.code === 'not_found') return null;
      throw err;
    }
  }

  /** Details and participants, or null when play-tools no longer has the tournament. */
  async function readTournament(gateway: StaffGateway, tournamentId: string) {
    const details = await detailsOf(gateway, tournamentId);
    if (!details) return null;
    const participants = await gateway.listTournamentParticipants(tournamentId);
    return { details, participants };
  }

  /**
   * One of the date's tournaments for this league, found in a professor's own list (play-tools lists
   * only the caller's tournaments), with the organizer to act as. Null when nobody has it on the date.
   * @throws StaffingError `organizer_not_connected`, `needs_reconnect`; PokemonUpstreamError when a
   *   professor who might have it couldn't be read
   */
  async function locate(leagueId: string, date: SessionDate, tournamentId: string) {
    const groupId = leagueGroup(leagueId);
    const conns = acting();
    const usable = conns.filter((c) => c.status === 'connected');
    const failures: PokemonUpstreamError[] = [];
    for (const c of usable) {
      const gateway = deps.staffGateway(c.id);
      let listed: Tournament[];
      try {
        listed = await gateway.listTournaments(localDay(date, timeZone));
      } catch (err) {
        if (!(err instanceof PokemonUpstreamError)) throw err;
        failures.push(err);
        continue;
      }
      const tournament = listed.find((t) => t.id === tournamentId && t.groupId === groupId);
      if (!tournament) continue;
      const details = await detailsOf(gateway, tournamentId);
      if (!details) return null;
      return { tournament, details, organizer: actingAs(details.organizerPlayerId, conns) };
    }
    // Nobody who could be read lists it. Its details say whose it is: a professor who isn't connected, or can't act.
    for (const c of usable) {
      let details: TournamentDetails | null;
      try {
        details = await detailsOf(deps.staffGateway(c.id), tournamentId);
      } catch (err) {
        if (!(err instanceof PokemonUpstreamError)) throw err;
        continue;
      }
      if (!details || details.groupId !== groupId || !startsOn(details, date)) break;
      // Fresh: a login refused while listing above is marked needs_reconnect by now.
      actingAs(details.organizerPlayerId, acting());
    }
    if (failures.length) throw failures[0];
    return null;
  }

  type DayRead = { tournament: Tournament; details: TournamentDetails; participants: TournamentParticipant[] };
  type DayOutcome = { connection: ActingConnection; outcome: ProfessorReadOutcome; message?: string };

  /**
   * The date's tournaments in this league, read one professor at a time, each with their own login (play-tools
   * lists only the caller's tournaments), seeding the staff list. A professor counts as read only when every call
   * for them succeeded; otherwise none of their tournaments are kept.
   */
  async function readDay(leagueId: string, date: SessionDate) {
    const groupId = leagueGroup(leagueId);
    const conns = acting();
    const reads: DayRead[] = [];
    const outcomes: DayOutcome[] = [];
    for (const c of conns) {
      if (c.status === 'needs_reconnect') {
        outcomes.push({ connection: c, outcome: { status: 'unread', code: 'needs_reconnect' }, message: 'This Pokémon login needs a reconnect in Settings.' });
        continue;
      }
      const gateway = deps.staffGateway(c.id);
      const theirs: DayRead[] = [];
      try {
        const listed = await gateway.listTournaments(localDay(date, timeZone));
        for (const tournament of listed) {
          if (tournament.groupId !== groupId || reads.some((r) => r.tournament.id === tournament.id)) continue;
          const read = await readTournament(gateway, tournament.id);
          if (!read) continue;
          recordUpstreamStaff(leagueId, read.details, read.participants);
          theirs.push({ tournament, ...read });
        }
      } catch (err) {
        if (!(err instanceof PokemonUpstreamError)) throw err;
        outcomes.push({ connection: c, outcome: { status: 'unread', code: err.code }, message: err.message });
        continue;
      }
      reads.push(...theirs);
      outcomes.push({ connection: c, outcome: { status: 'read' } });
    }
    reads.sort((a, b) => byStart(a.tournament, b.tournament));
    return { conns, reads, outcomes };
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

  function assertRole(role: string) {
    if (!roles().some((r) => r.code === role)) {
      throw new StaffingError('unknown_role', `"${role}" is not a staff role play-tools offers.`);
    }
  }

  const unknownTournament = (tournamentId: string, date: SessionDate) =>
    new StaffingError('unknown_tournament', `Tournament ${tournamentId} is not one of this league's tournaments on ${date}.`);

  /** One of the date's tournaments for this league, read fresh as its organizer, or `unknown_tournament`. */
  async function freshTournament(leagueId: string, date: SessionDate, tournamentId: string) {
    const found = await locate(leagueId, date, tournamentId);
    if (!found) throw unknownTournament(tournamentId, date);
    const participants = await deps.staffGateway(found.organizer.id).listTournamentParticipants(tournamentId);
    return { ...found, participants };
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
    const found = await locate(leagueId, date, tournamentId);
    if (!found && orMissing) return;
    if (!found) {
      throw new StaffingError('tournament_locked', 'Play-tools no longer lists this tournament; its staff can no longer change.');
    }
    assertEditable(found.tournament);
  }

  function recordAppStaff(leagueId: string, rows: readonly AppStaffRow[]): void {
    if (rows.length === 0) return;
    db.transaction(() => {
      roster.ensurePlayers(leagueId, rows.map((r) => ({ playerId: r.playerId })));
      upsertHistory(leagueId, rows, 'app');
    });
  }

  const ofTournament = (leagueId: string, tournamentId: string) =>
    db
      .select()
      .from(staffAssignment)
      .where(and(eq(staffAssignment.leagueId, leagueId), eq(staffAssignment.tournamentId, tournamentId)))
      .orderBy(asc(staffAssignment.id))
      .all();

  const liveById = (leagueId: string, assignmentId: number) =>
    db
      .select()
      .from(staffAssignment)
      .where(and(eq(staffAssignment.id, assignmentId), eq(staffAssignment.leagueId, leagueId), isNull(staffAssignment.removedAt)))
      .get();

  return {
    listRoles: () => roles(),

    async changeRole(leagueId, date, assignmentId, role) {
      const row = liveOn(leagueId, date, assignmentId);
      assertRole(role);
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
      assertRole(input.role);
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
      const { conns, reads, outcomes } = await readDay(leagueId, date);
      const unread: UnreadProfessor[] = outcomes.flatMap(({ connection, outcome, message }) =>
        outcome.status === 'unread' ? [{ professor: professorOf(connection), code: outcome.code, message: message! }] : [],
      );

      const rows = assignmentsOn(leagueId, date);
      const upstreamStaff = reads.flatMap((r) => r.participants.filter((p) => p.isStaff));
      const names = namesOf(leagueId, [...rows.map((r) => r.playerId as PlayerId), ...upstreamStaff.map((p) => p.playerId)]);

      const tournaments: TournamentStaffView[] = reads.map(({ tournament, details, participants }) => {
        const ours = rows.filter((r) => r.tournamentId === tournament.id);
        const ourRecords = new Set(ours.map((r) => r.recordId).filter(Boolean));
        const organizer = organizerOf(details.organizerPlayerId, conns);
        return {
          tournamentId: tournament.id,
          label: labelOf(tournament),
          startsAt: tournament.startsAt?.toISOString() ?? null,
          editable: isEditable(tournament) && organizer.connected,
          organizer,
          assignments: ours.map((r) => toView(r, names)),
          upstreamOnly: participants
            .filter((p) => p.isStaff && p.role !== 'organizer' && p.playerId !== details.organizerPlayerId && !ourRecords.has(p.recordId))
            .map((p) => ({ playerId: p.playerId, name: names.get(p.playerId) || p.name, role: p.role ?? '' })),
          players: participants.filter((p) => !p.isStaff).map((p) => ({ playerId: p.playerId })),
        };
      });

      const shown = new Set(reads.map((r) => r.tournament.id));
      const missing = new Map<string, AssignmentRow[]>();
      // Once everyone was read and nobody lists it, its staff records went with it and no staff job can reach it: a
      // tombstone there would show as removing forever (#148). Someone unread may still list it, so theirs stay.
      const pending = (r: AssignmentRow) => !r.removedAt || unread.length > 0;
      for (const row of rows.filter((r) => !shown.has(r.tournamentId) && pending(r))) {
        missing.set(row.tournamentId, [...(missing.get(row.tournamentId) ?? []), row]);
      }
      for (const [tournamentId, group] of missing) {
        tournaments.push({
          tournamentId,
          label: group[0]!.tournamentLabel,
          startsAt: null,
          editable: false,
          // A professor who couldn't be read may still list it.
          ...(unread.length ? { unavailable: true as const } : { missing: true as const }),
          organizer: null,
          assignments: group.map((r) => toView(r, names)),
          upstreamOnly: [],
          players: [],
        });
      }
      return { timeZone, tournaments, unread };
    },

    async daySnapshot(leagueId, date) {
      const { reads, outcomes } = await readDay(leagueId, date);
      const live = assignmentsOn(leagueId, date).filter((r) => r.removedAt === null);
      const names = namesOf(leagueId, live.map((r) => r.playerId as PlayerId));
      return {
        timeZone,
        tournaments: reads.map(({ tournament, details }) => ({
          tournament,
          organizerPlayerId: details.organizerPlayerId,
          staff: live
            .filter((r) => r.tournamentId === tournament.id)
            .map((r) => ({ playerId: r.playerId as PlayerId, name: names.get(r.playerId) ?? '', role: r.role })),
        })),
        professors: outcomes.map(({ connection, outcome }) => ({ connectionId: connection.id, outcome })),
      };
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

    recordAppStaff,

    async prepareApply(leagueId, date, tournamentId) {
      const found = await locate(leagueId, date, tournamentId);
      if (!found) throw unknownTournament(tournamentId, date);
      const { tournament, organizer } = found;
      assertEditable(tournament);
      const rows = ofTournament(leagueId, tournamentId);
      if (rows.length === 0) throw new StaffingError('nothing_to_apply', 'This tournament has no staff to assign or remove.');
      for (const row of rows.filter((r) => !r.removedAt)) assertRole(row.role);
      return {
        tournamentId,
        label: labelOf(tournament),
        professor: { connectionId: organizer.id, playerId: organizer.professorPlayerId!, name: organizer.professorName },
      };
    },

    assignmentsFor(leagueId, tournamentId) {
      return ofTournament(leagueId, tournamentId).map((r) => ({
        id: r.id,
        playerId: r.playerId as PlayerId,
        role: r.role,
        appliedRole: r.appliedRole,
        recordId: r.recordId,
        removed: r.removedAt !== null,
      }));
    },

    recordApplied(leagueId, assignmentId, applied) {
      db.transaction(() => {
        const row = liveById(leagueId, assignmentId);
        if (!row) return;
        db.update(staffAssignment)
          .set({
            state: 'assigned',
            recordId: applied.recordId,
            // The organizer may have changed the wanted role while the job ran: the next job sends it.
            appliedRole: row.role === applied.role ? null : applied.role,
            assignedAt: row.assignedAt ?? now(),
          })
          .where(eq(staffAssignment.id, row.id))
          .run();
        recordAppStaff(leagueId, [
          { tournamentId: row.tournamentId, playerId: row.playerId as PlayerId, role: applied.role, tournamentDate: row.sessionDate as SessionDate },
        ]);
      });
    },

    recordFailed(leagueId, assignmentId) {
      db.update(staffAssignment)
        .set({ state: 'failed' })
        .where(and(eq(staffAssignment.id, assignmentId), eq(staffAssignment.leagueId, leagueId), isNull(staffAssignment.removedAt)))
        .run();
    },

    forgetRemoved(leagueId, assignmentId) {
      db.delete(staffAssignment)
        .where(and(eq(staffAssignment.id, assignmentId), eq(staffAssignment.leagueId, leagueId), isNotNull(staffAssignment.removedAt)))
        .run();
    },

    moveTournament(leagueId, tournamentId, to) {
      return db
        .update(staffAssignment)
        .set({ sessionDate: to })
        .where(and(eq(staffAssignment.leagueId, leagueId), eq(staffAssignment.tournamentId, tournamentId)))
        .run().changes;
    },

    cancelTournament(leagueId, tournamentId) {
      const ofIt = and(eq(staffAssignment.leagueId, leagueId), eq(staffAssignment.tournamentId, tournamentId));
      return db.transaction(() => ({
        dropped: db.delete(staffAssignment).where(and(ofIt, isNull(staffAssignment.recordId))).run().changes,
        removed: db
          .update(staffAssignment)
          .set({ removedAt: now(), state: 'removing' })
          .where(and(ofIt, isNotNull(staffAssignment.recordId), isNull(staffAssignment.removedAt)))
          .run().changes,
      }));
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
