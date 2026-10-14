import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApplyBody } from '../../../shared/schemas/tournaments';
import { localInstant } from '../../../shared/time/local-time';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import { type SightingsService, createSightingsService } from '../metrics/sightings';
import { PokemonUpstreamError } from '../pokemon/ports/errors';
import type { TournamentChanges, TournamentDetails } from '../pokemon/ports/play-tools-gateway';
import { type RosterService, createRosterService } from '../roster/service';
import { type SessionsService, createSessionsService } from '../sessions/service';
import { type TournamentsService, createTournamentsService } from '../tournaments/service';
import { BROCK, VENUE, stubPlayTools, templateBody, upstreamTournament } from '../tournaments/test-helpers';
import type { PlaySessionResolver } from './resolve';
import { type SubmissionService, createSubmissionService } from './service';

// The `tournament_edit` job (#93, ADR-0010 decisions 8 and 11) on the submission rails: a fresh read before each
// item, only the differing fields sent, one PATCH at a time and paced, a 5xx settled by one re-read and never resent.
// Every wait is the fake clock's.

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const TZ = 'America/Chicago';
const LIBRARY = { id: '00000000-0000-4000-8000-000000000052', label: 'Library', timeZone: TZ, country: 'US' };
const TUESDAYS = { kind: 'weekly', weekday: 2, every: 1 } as const;
const guid = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;

let database: OpenDatabase;
let roster: RosterService;
let sightings: SightingsService;
let sessions: SessionsService;
let upstream: ReturnType<typeof stubPlayTools>;
let tournaments: TournamentsService;
let service: SubmissionService;
let clock: Date;
/** Every PATCH sent: when (fake clock), as which connection, to which tournament, and exactly what. */
let patches: { at: number; as: number; tournamentId: string; changes: TournamentChanges }[];
/** Decides each PATCH (1-based): fail it, after landing it or not. The default lands it. */
let onPatch: ((n: number) => Promise<{ fail: PokemonUpstreamError; landed?: boolean } | undefined> | { fail: PokemonUpstreamError; landed?: boolean } | undefined) | undefined;
/** Runs before each tournament read, numbered from 1. */
let onRead: ((n: number) => void) | undefined;
let readCount: number;
let moved: { tournamentId: string; to: string }[];

const noResolver: PlaySessionResolver = { resolve: () => Promise.reject(new Error('never')), find: () => Promise.reject(new Error('never')) };
const noAttendance = {
  listAttendance: () => Promise.reject(new Error('never')),
  addAttendanceBulk: () => Promise.reject(new Error('never')),
  removeAttendance: () => Promise.reject(new Error('never')),
};

/** play-tools as one connection, with reads numbered and edits logged. */
function playTools(connectionId: number) {
  const base = upstream.gateway(connectionId);
  return {
    ...base,
    async getTournament(id: string) {
      onRead?.(++readCount);
      return base.getTournament(id);
    },
    async editTournament(id: string, changes: TournamentChanges) {
      patches.push({ at: clock.getTime(), as: connectionId, tournamentId: id, changes });
      const behaviour = await onPatch?.(patches.length);
      if (behaviour) {
        if (behaviour.landed) await base.editTournament(id, changes);
        throw behaviour.fail;
      }
      return base.editTournament(id, changes);
    },
  };
}

function build(over: { tournamentDelayMs?: number } = {}): SubmissionService {
  return createSubmissionService({
    db: database.db,
    sessions,
    roster,
    sightings,
    connections: upstream.connections,
    gateway: () => noAttendance,
    staffGateway: () => {
      throw new Error('a tournament job never uses the staff gateway');
    },
    tournamentGateway: (connectionId) => playTools(connectionId) as never,
    staffing: {} as never,
    tournaments,
    resolver: noResolver,
    timeZone: TZ,
    now: () => clock,
    sleep: async (ms, signal) => {
      if (signal.aborted) throw signal.reason;
      clock = new Date(clock.getTime() + ms);
    },
    ...(over.tournamentDelayMs !== undefined && { tournamentDelayMs: over.tournamentDelayMs }),
  });
}

beforeEach(() => {
  database = openDatabase(':memory:');
  migrateDatabase(database.db, MIGRATIONS_DIR);
  roster = createRosterService({ db: database.db });
  sightings = createSightingsService({ db: database.db });
  sessions = createSessionsService({ db: database.db, roster, sightings });
  upstream = stubPlayTools();
  upstream.state.professors.push({ ...BROCK });
  upstream.state.venues.push({ id: LIBRARY.id, name: 'Library', formattedAddress: null, country: 'US', timeZone: TZ });
  clock = new Date('2026-10-14T17:00:00Z'); // Wednesday, noon in Chicago
  patches = [];
  onPatch = undefined;
  onRead = undefined;
  readCount = 0;
  moved = [];
  tournaments = createTournamentsService({
    db: database.db,
    connections: upstream.connections,
    gateway: (c) => playTools(c),
    staffing: { moveTournament: (_l, tournamentId, to) => (moved.push({ tournamentId, to }), 1), cancelTournament: () => ({ dropped: 0, removed: 0 }) },
    timeZone: TZ,
    now: () => clock,
  });
  service = build();
});
afterEach(() => database.close());

type Row = { id: number; state: string; local_date: string; overrides: string; display_id: string | null; upstream_status: string | null };
const rowOf = (id: number) => database.sqlite.prepare('select * from planned_tournament where id = ?').get(id) as Row;
const setRow = (id: number, set: string) => database.sqlite.prepare(`update planned_tournament set ${set} where id = ?`).run(id);
const stubOf = (n: number) => upstream.state.tournaments.find((t) => t.id === guid(n))!;

/** A weekly Tuesday schedule planned on read; `created` of its rows from 10-20 on are in play-tools. */
async function weekly(created: number) {
  const t = tournaments.createTemplate(L, templateBody({ name: 'Tuesday Cup', type: { kind: 'custom' }, details: 'Bring a deck.' }));
  const scaffold = tournaments.createScaffold(L, { name: 'Tuesdays', slots: [{ templateId: t.id, dayOffset: 0, startTime: null }] });
  const schedule = tournaments.createSchedule(L, { scaffoldId: scaffold.id, rule: TUESDAYS, startsOn: '2026-09-01', endsOn: null, horizonWeeks: 6 });
  await tournaments.upcoming(L, {});
  const rows = (database.sqlite.prepare('select * from planned_tournament where schedule_id = ? order by local_date').all(schedule.id) as Row[]).filter(
    (r) => r.local_date >= '2026-10-20',
  );
  rows.slice(0, created).forEach((r, i) => {
    const startsAt = localInstant(r.local_date, '18:00', TZ);
    const details: Partial<TournamentDetails> = {
      venue: { id: VENUE.id, timeZone: TZ },
      contact: { email: 'league@example.com', phone: null },
      details: 'Bring a deck.',
      registration: { startsAt: new Date(startsAt.getTime() - 3_600_000), endsAt: new Date(startsAt.getTime() + 900_000) },
    };
    upstream.state.tournaments.push(upstreamTournament(guid(i + 1), startsAt.toISOString(), { name: 'Tuesday Cup', details }));
    setRow(r.id, `state = 'created', tournament_id = '${guid(i + 1)}'`);
  });
  readCount = 0;
  return rows;
}

async function edit(plannedId: number, raw: Record<string, unknown>) {
  const started = await service.editTournaments(L, { target: { kind: 'planned', id: plannedId }, body: ApplyBody.parse(raw), startedBy: 'organizer' });
  await service.idle();
  return started;
}
const items = (submissionId: number) => service.get(L, submissionId).tournamentItems;

describe('the tournament_edit job', () => {
  it('sends only the fields that differ from a fresh read, so a change made meanwhile survives', async () => {
    const [row] = await weekly(1);
    // After the apply's own read, play-tools gains a details change the organizer didn't make here.
    onRead = (n) => {
      if (n === 2) stubOf(1).details!.details = 'Changed in play-tools';
    };

    const { submissionId } = await edit(row!.id, { changes: { venue: LIBRARY } });

    expect(patches).toEqual([{ at: expect.any(Number), as: 1, tournamentId: guid(1), changes: { venueId: LIBRARY.id } }]);
    expect(stubOf(1).details!.details).toBe('Changed in play-tools');
    expect(items(submissionId!)).toEqual([expect.objectContaining({ outcome: 'edited', tournamentId: guid(1), label: 'Tuesday Cup · 2026-10-20' })]);
    expect(service.get(L, submissionId!)).toMatchObject({ status: 'succeeded', kind: 'tournament_edit', playSessionLabel: 'Edit Tuesday Cup · 2026-10-20' });
    expect(JSON.parse(rowOf(row!.id).overrides)).toEqual({ venue: LIBRARY });
  });

  it('is already_applied, with no PATCH, when play-tools already holds the change', async () => {
    const [row] = await weekly(1);
    onRead = (n) => {
      if (n === 2) stubOf(1).details!.venue = { id: LIBRARY.id, timeZone: TZ };
    };
    const { submissionId } = await edit(row!.id, { changes: { venue: LIBRARY } });
    expect(patches).toEqual([]);
    expect(items(submissionId!)[0]).toMatchObject({ outcome: 'already_applied' });
    expect(service.get(L, submissionId!).counts).toMatchObject({ added: 0, alreadyPresent: 1 });
  });

  it('counts a 500 whose change landed as edited, with one PATCH', async () => {
    const [row] = await weekly(1);
    onPatch = () => ({ fail: new PokemonUpstreamError('unavailable', 'play-tools answered 500'), landed: true });
    const { submissionId } = await edit(row!.id, { changes: { details: 'New' } });
    expect(patches).toHaveLength(1);
    expect(items(submissionId!)[0]).toMatchObject({ outcome: 'edited' });
  });

  it('fails a 500 whose change did not land, never resends it, and a retry re-reads first', async () => {
    const [row] = await weekly(1);
    onPatch = () => ({ fail: new PokemonUpstreamError('unavailable', 'play-tools answered 500') });
    const { submissionId } = await edit(row!.id, { changes: { details: 'New' } });
    expect(patches).toHaveLength(1);
    expect(items(submissionId!)[0]).toMatchObject({ outcome: 'failed', errorCode: 'unavailable' });
    expect(service.get(L, submissionId!).status).toBe('failed');

    onPatch = undefined;
    const retry = await service.retry(L, submissionId!, 'organizer');
    await service.idle();
    expect(patches).toHaveLength(2);
    expect(service.get(L, retry.submissionId)).toMatchObject({ status: 'succeeded', retryOf: submissionId });
  });

  it('records a refusal with support details and goes on; a 403 stops the job', async () => {
    const [first] = await weekly(3);
    const refusal = new PokemonUpstreamError('refused', 'Editing a tournament: Invalid address.', {
      status: 400,
      upstream: { message: 'Invalid address.', correlationId: 'corr-1' },
    });
    onPatch = (n) => (n === 1 ? { fail: refusal } : undefined);
    const { submissionId } = await edit(first!.id, { changes: { details: 'New' }, scope: 'later' });
    const [a, b] = items(submissionId!);
    expect(a).toMatchObject({
      outcome: 'refused',
      errorCode: 'refused',
      support: { action: 'edit', league: { displayId: 'L5012' }, tournament: { displayId: `26-10-${guid(1)}`, name: 'Tuesday Cup', date: '2026-10-20' }, status: 400, message: 'Invalid address.', correlationId: 'corr-1' },
    });
    expect(b).toMatchObject({ outcome: 'edited' });
    expect(service.get(L, submissionId!).status).toBe('partial');

    patches = [];
    onPatch = () => ({ fail: new PokemonUpstreamError('forbidden', 'Forbidden') });
    const stopped = await edit(first!.id, { changes: { details: 'Newer' }, scope: 'later' });
    expect(patches).toHaveLength(1);
    expect(items(stopped.submissionId!).map((i) => i.outcome)).toEqual(['refused', 'skipped', 'skipped']);
    expect(service.get(L, stopped.submissionId!).status).toBe('failed');
  });

  it('keeps PATCHes at least 2 s apart whatever the setting', async () => {
    service = build({ tournamentDelayMs: 0 });
    const [first] = await weekly(3);
    await edit(first!.id, { changes: { details: 'New' }, scope: 'later' });
    expect(patches.map((p) => p.at - patches[0]!.at)).toEqual([0, 2_000, 4_000]);
  });

  it('refuses a reschedule that falls out of the creatable window at midnight, sending nothing', async () => {
    clock = new Date('2026-10-22T17:00:00Z'); // Thursday: the window starts on the 20th
    // A tournament made in play-tools, held yesterday (Wednesday the 21st), moved back to the 20th.
    upstream.state.tournaments.push(upstreamTournament(guid(50), '2026-10-21T23:00:00Z', { details: { venue: { id: VENUE.id, timeZone: TZ }, contact: { email: 'a@example.com', phone: null } } }));
    onRead = (n) => {
      if (n === 2) clock = new Date('2026-10-23T06:00:00Z'); // past midnight in Chicago: now from the 21st
    };
    const { submissionId } = await service.editTournaments(L, {
      target: { kind: 'tournament', id: guid(50) },
      body: ApplyBody.parse({ changes: { localDate: '2026-10-20' } }),
      startedBy: 'organizer',
    });
    await service.idle();
    expect(patches).toEqual([]);
    expect(items(submissionId!)[0]).toMatchObject({ outcome: 'date_too_far_past' });
  });

  it('moves a rescheduled tournament’s staff and planned row, and stores the status play-tools gives it', async () => {
    clock = new Date('2026-10-18T17:00:00Z');
    const [row] = await weekly(1);
    onPatch = () => {
      stubOf(1).applicationState = 'approval-pending';
      return undefined;
    };
    const { submissionId } = await edit(row!.id, { changes: { localDate: '2026-10-22' }, acknowledgeShortNotice: true });

    expect(patches[0]!.changes).toEqual({
      startsAt: new Date('2026-10-22T23:00:00Z'),
      registration: { startsAt: new Date('2026-10-22T22:00:00Z'), endsAt: new Date('2026-10-22T23:15:00Z') },
    });
    expect(moved).toEqual([{ tournamentId: guid(1), to: '2026-10-22' }]);
    expect(rowOf(row!.id)).toMatchObject({ local_date: '2026-10-22', upstream_status: 'approval-pending' });
    expect(items(submissionId!)[0]).toMatchObject({ outcome: 'edited', error: expect.stringContaining('approval') });
    expect(service.get(L, submissionId!).playSessionLabel).toBe('Reschedule Tuesday Cup · 2026-10-20');
  });

  it('answers 200 with no job for an edit of planned tournaments only', async () => {
    const rows = await weekly(0);
    const started = await service.editTournaments(L, { target: { kind: 'planned', id: rows[0]!.id }, body: ApplyBody.parse({ changes: { details: 'New' }, scope: 'later' }), startedBy: 'organizer' });
    expect(started).toEqual({ submissionId: null, updatedLocally: rows.length });
    expect(patches).toEqual([]);
  });

  it('refuses while another job holds the lease, writing nothing', async () => {
    const [first, second] = await weekly(2);
    let release!: () => void;
    onPatch = () => new Promise((r) => (release = () => r(undefined)));
    await service.editTournaments(L, { target: { kind: 'planned', id: first!.id }, body: ApplyBody.parse({ changes: { details: 'A' } }), startedBy: 'organizer' });
    await expect(
      service.editTournaments(L, { target: { kind: 'planned', id: second!.id }, body: ApplyBody.parse({ changes: { details: 'B' }, scope: 'later' }), startedBy: 'organizer' }),
    ).rejects.toMatchObject({ code: 'submission_running' });
    expect(JSON.parse(rowOf(second!.id).overrides)).toEqual({});
    expect(database.sqlite.prepare('select count(*) as n from tournament_schedule_override').get()).toEqual({ n: 0 });
    release();
    await service.idle();
  });

  it('on boot, a PATCH in flight is unknown and the rest skipped; a retry takes both', async () => {
    const [first] = await weekly(2);
    onPatch = () => new Promise(() => {}); // the app dies mid-call
    const { submissionId } = await service.editTournaments(L, { target: { kind: 'planned', id: first!.id }, body: ApplyBody.parse({ changes: { details: 'New' }, scope: 'later' }), startedBy: 'organizer' });
    await new Promise((r) => setImmediate(r));

    const rebooted = build();
    expect(rebooted.recoverInterrupted()).toBe(1);
    expect(rebooted.get(L, submissionId!)).toMatchObject({ status: 'interrupted' });
    expect(items(submissionId!).map((i) => i.outcome)).toEqual(['unknown', 'skipped']);

    onPatch = undefined;
    const retry = await rebooted.retry(L, submissionId!, 'organizer');
    await rebooted.idle();
    expect(rebooted.get(L, retry.submissionId).tournamentItems.map((i) => i.outcome)).toEqual(['edited', 'edited']);
  });
});
