import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApplyBody, type CancelBody } from '../../../shared/schemas/tournaments';
import { localInstant } from '../../../shared/time/local-time';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import { type SightingsService, createSightingsService } from '../metrics/sightings';
import { PokemonUpstreamError } from '../pokemon/ports/errors';
import type { TournamentDetails } from '../pokemon/ports/play-tools-gateway';
import { type RosterService, createRosterService } from '../roster/service';
import { type SessionsService, createSessionsService } from '../sessions/service';
import { createStaffingService } from '../staffing/service';
import { type TournamentsService, createTournamentsService } from '../tournaments/service';
import { OLIVE, VENUE, participants, stubPlayTools, templateBody, upstreamTournament } from '../tournaments/test-helpers';
import type { PlaySessionResolver } from './resolve';
import { type SubmissionService, createSubmissionService } from './service';

// The `tournament_cancel` job (#94, ADR-0010 decision 8) on the submission rails: the apply's fresh read and typed
// confirmation, a fresh read again before the one PATCH, a 5xx settled by one re-read and never resent, then the planned
// row cancelled and its staff dropped or tombstoned. Every wait is the fake clock's.

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const TZ = 'America/Chicago';
const GUID = 'aaaaaaaa-0000-4000-8000-000000000001';
const START = localInstant('2026-10-20', '18:00', TZ);

let database: OpenDatabase;
let roster: RosterService;
let sightings: SightingsService;
let sessions: SessionsService;
let upstream: ReturnType<typeof stubPlayTools>;
let tournaments: TournamentsService;
let service: SubmissionService;
let clock: Date;
/** Every write sent (cancel or edit): when (fake clock), as which connection, to which tournament. */
let writes: { at: number; as: number; tournamentId: string; kind: 'cancel' | 'edit' }[];
/** Decides each cancel (1-based): fail it (after landing it or not), or answer 204 without play-tools changing. */
let onCancel: ((n: number) => Promise<Behaviour> | Behaviour) | undefined;
type Behaviour = { fail: PokemonUpstreamError; landed?: boolean } | 'ignored' | undefined;
/** Runs before each tournament read, numbered from 1; a promise holds the read until it settles. */
let onRead: ((n: number) => unknown) | undefined;
let readCount: number;
/** Runs after each paced wait. */
let onSleep: (() => void) | undefined;
let logged: { message: string; meta: unknown }[];

const noResolver: PlaySessionResolver = { resolve: () => Promise.reject(new Error('never')), find: () => Promise.reject(new Error('never')) };
const noAttendance = {
  listPlaySessions: () => Promise.reject(new Error('this job never lists play sessions')),
  listAttendance: () => Promise.reject(new Error('never')),
  addAttendanceBulk: () => Promise.reject(new Error('never')),
  removeAttendance: () => Promise.reject(new Error('never')),
};

/** play-tools as one connection, with reads numbered and writes logged. */
function playTools(connectionId: number) {
  const base = upstream.gateway(connectionId);
  return {
    ...base,
    async getTournament(id: string) {
      await onRead?.(++readCount);
      return base.getTournament(id);
    },
    async editTournament(id: string, changes: Parameters<typeof base.editTournament>[1]) {
      writes.push({ at: clock.getTime(), as: connectionId, tournamentId: id, kind: 'edit' });
      return base.editTournament(id, changes);
    },
    async cancelTournament(id: string) {
      writes.push({ at: clock.getTime(), as: connectionId, tournamentId: id, kind: 'cancel' });
      const behaviour = await onCancel?.(writes.filter((w) => w.kind === 'cancel').length);
      if (behaviour === 'ignored') return 'cancelled' as const;
      if (behaviour) {
        if (behaviour.landed) await base.cancelTournament(id);
        throw behaviour.fail;
      }
      return base.cancelTournament(id);
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
      onSleep?.();
    },
    log: { warn: (message, meta) => logged.push({ message, meta }), info: (message, meta) => logged.push({ message, meta }) },
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
  clock = new Date('2026-10-14T17:00:00Z'); // Wednesday, noon in Chicago
  writes = [];
  onCancel = undefined;
  onRead = undefined;
  readCount = 0;
  onSleep = undefined;
  logged = [];
  const staffing = createStaffingService({
    db: database.db,
    roster,
    connections: upstream.connections,
    staffGateway: () => {
      throw new Error('a cancel never calls staffing upstream');
    },
    timeZone: TZ,
    now: () => clock,
  });
  tournaments = createTournamentsService({
    db: database.db,
    connections: upstream.connections,
    gateway: (c) => playTools(c),
    staffing,
    timeZone: TZ,
    now: () => clock,
  });
  service = build();
});
afterEach(() => database.close());

type Row = { id: number; state: string; upstream_status: string | null; display_id: string | null };
const rowOf = (id: number) => database.sqlite.prepare('select * from planned_tournament where id = ?').get(id) as Row;
const stub = () => upstream.state.tournaments.find((t) => t.id === GUID)!;
const cancels = () => writes.filter((w) => w.kind === 'cancel');
const jobs = () => database.sqlite.prepare("select id from submission where kind = 'tournament_cancel'").all();
const staffRows = () => database.sqlite.prepare('select player_id, state, removed_at is not null as tombstoned from staff_assignment order by player_id').all();

const details: Partial<TournamentDetails> = { venue: { id: VENUE.id, timeZone: TZ }, editableUntil: new Date(START.getTime() + 90 * 86_400_000) };

/** A planned row created in play-tools as Olive's tournament, listing `players`, with one pending and one applied staffer. */
function created(counts: { players?: number; staff?: number } = {}, name = 'Tuesday Cup') {
  const t = tournaments.createTemplate(L, templateBody({ name, type: { kind: 'custom' } }));
  const planned = tournaments.createPlanned(L, { templateId: t.id, localDate: '2026-10-20' });
  const id = planned.plannedId!;
  upstream.state.tournaments.push(upstreamTournament(GUID, START.toISOString(), { name, displayId: '26-10-000001', details }));
  upstream.state.participants.set(GUID, participants(OLIVE.professorPlayerId!, counts));
  database.sqlite.prepare(`update planned_tournament set state = 'created', tournament_id = ? where id = ?`).run(GUID, id);
  for (const [playerId, state, recordId] of [
    ['00111', 'pending', null],
    ['00222', 'assigned', 'rec-222'],
  ] as const) {
    database.sqlite.prepare("insert or ignore into player (player_id, display_name, first_seen_at) values (?, 'Staffer Name', 0)").run(playerId);
    database.sqlite
      .prepare(
        `insert into staff_assignment (league_id, session_date, tournament_id, tournament_label, player_id, role, state, record_id, created_by, created_at)
         values (?, '2026-10-20', ?, 'Tuesday Cup', ?, 'judge', ?, ?, 'organizer', 0)`,
      )
      .run(L, GUID, playerId, state, recordId);
  }
  readCount = 0;
  return id;
}

async function cancel(plannedId: number, body: CancelBody = {}) {
  const started = await service.cancelTournament(L, { target: { kind: 'planned', id: plannedId }, body, startedBy: 'organizer' });
  await service.idle();
  return started;
}
const items = (submissionId: number) => service.get(L, submissionId).tournamentItems;
const UNTOUCHED = [
  { player_id: '00111', state: 'pending', tombstoned: 0 },
  { player_id: '00222', state: 'assigned', tombstoned: 0 },
];

describe("dropping coverage's cached listings (#95)", () => {
  /** The status of every job each time the listings are dropped. */
  let drops: string[][];
  beforeEach(() => {
    drops = [];
    (tournaments.requiredEvents as { listingsChanged: () => void }).listingsChanged = () =>
      drops.push((database.sqlite.prepare('select status from submission order by id').all() as { status: string }[]).map((r) => r.status));
  });

  it('drops them once when a tournament job has ended, and not before', async () => {
    const id = created();
    await cancel(id);
    expect(drops).toEqual([['succeeded']]);
  });

  it('drops them when a tournament job ends badly too', async () => {
    const id = created();
    onCancel = () => ({ fail: new PokemonUpstreamError('forbidden', 'Request not authorized for attempted action.') });
    const { submissionId } = await cancel(id);
    expect(service.get(L, submissionId!).status).not.toBe('running');
    expect(drops).toHaveLength(1);
  });

  it('still ends the job cleanly if dropping them throws', async () => {
    (tournaments.requiredEvents as { listingsChanged: () => void }).listingsChanged = () => {
      throw new Error('cache gone');
    };
    const id = created();
    const { submissionId } = await cancel(id);
    expect(service.get(L, submissionId!).status).toBe('succeeded');
    expect(logged.some((l) => l.message.includes('cache gone'))).toBe(true);
  });

  it('leaves them alone for a job that is not a tournament job', async () => {
    await service.importPlayers(L, 'organizer');
    await service.idle();
    expect(drops).toEqual([]);
  });
});

describe('the tournament_cancel job', () => {
  it('sends one cancel as the organizer, then cancels the planned row and drops or tombstones its staff', async () => {
    const id = created();

    const { submissionId } = await cancel(id);

    expect(cancels()).toEqual([{ at: expect.any(Number), as: OLIVE.id, tournamentId: GUID, kind: 'cancel' }]);
    expect(service.get(L, submissionId!)).toMatchObject({
      status: 'succeeded',
      kind: 'tournament_cancel',
      playSessionLabel: 'Cancel Tuesday Cup · 2026-10-20',
      professor: { playerId: OLIVE.professorPlayerId, name: OLIVE.professorName },
      counts: { added: 1, alreadyPresent: 0, failed: 0, skipped: 0 },
    });
    expect(items(submissionId!)).toEqual([
      expect.objectContaining({ outcome: 'cancelled', plannedTournamentId: id, tournamentId: GUID, label: 'Tuesday Cup · 2026-10-20' }),
    ]);
    expect(rowOf(id)).toMatchObject({ state: 'cancelled', upstream_status: 'cancelled', display_id: '26-10-000001' });
    expect(staffRows()).toEqual([{ player_id: '00222', state: 'removing', tombstoned: 1 }]);
  });

  it('refuses a wrong or missing confirmation when anyone is registered, and starts nothing', async () => {
    const id = created({ players: 2 });
    for (const body of [{}, { confirmation: '26-10-000002' }]) {
      await expect(service.cancelTournament(L, { target: { kind: 'planned', id }, body, startedBy: 'organizer' })).rejects.toMatchObject({
        code: 'confirmation_mismatch',
      });
    }
    expect(jobs()).toEqual([]);
    expect(rowOf(id).state).toBe('created');
    expect(staffRows()).toEqual(UNTOUCHED);

    const { submissionId } = await cancel(id, { confirmation: '26-10-000001' });
    expect(items(submissionId!)[0]).toMatchObject({ outcome: 'cancelled' });
  });

  it('answers already_cancelled with no job and no call, cancels locally, and logs who did it', async () => {
    const id = created();
    stub().applicationState = 'cancelled';

    expect(await cancel(id)).toEqual({ submissionId: null, outcome: 'already_cancelled' });

    expect(cancels()).toEqual([]);
    expect(jobs()).toEqual([]);
    expect(rowOf(id)).toMatchObject({ state: 'cancelled', upstream_status: 'cancelled' });
    expect(staffRows()).toEqual([{ player_id: '00222', state: 'removing', tombstoned: 1 }]);
    const line = logged.find((l) => l.message.includes('already cancelled'));
    expect(line?.meta).toEqual({ by: 'organizer', tournamentId: GUID, plannedTournamentId: id, dropped: 1, removed: 1 });
    expect(JSON.stringify(logged)).not.toContain('Staffer Name');
  });

  it('is already_cancelled at its turn when play-tools cancelled it after the apply, sending nothing', async () => {
    const id = created();
    onRead = (n) => {
      if (n === 2) stub().applicationState = 'cancelled';
    };
    const { submissionId } = await cancel(id);
    expect(cancels()).toEqual([]);
    expect(items(submissionId!)[0]).toMatchObject({ outcome: 'already_cancelled' });
    expect(service.get(L, submissionId!)).toMatchObject({ status: 'succeeded', counts: { added: 0, alreadyPresent: 1 } });
    expect(rowOf(id).state).toBe('cancelled');
  });

  it.each([
    ['completed', () => ((stub() as { status: string }).status = 'complete'), 'tournament_locked'],
    ['gone', () => (upstream.state.tournaments.length = 0), 'unknown_tournament'],
  ])('fails, sending nothing, when the tournament is %s at its turn', async (_what, change, code) => {
    const id = created();
    onRead = (n) => {
      if (n === 2) change();
    };
    const { submissionId } = await cancel(id);
    expect(cancels()).toEqual([]);
    expect(items(submissionId!)[0]).toMatchObject({ outcome: 'failed', errorCode: code });
    expect(service.get(L, submissionId!).status).toBe('failed');
    expect(rowOf(id).state).toBe('created');
    expect(staffRows()).toEqual(UNTOUCHED);
  });

  it('counts a 500 whose cancel landed as cancelled, with one call', async () => {
    const id = created();
    onCancel = () => ({ fail: new PokemonUpstreamError('unavailable', 'play-tools answered 500'), landed: true });
    const { submissionId } = await cancel(id);
    expect(cancels()).toHaveLength(1);
    expect(items(submissionId!)[0]).toMatchObject({ outcome: 'cancelled' });
    expect(rowOf(id).state).toBe('cancelled');
  });

  it('fails a 500 whose cancel did not land, never resends it, and a retry re-reads then sends once', async () => {
    const id = created();
    onCancel = () => ({ fail: new PokemonUpstreamError('unavailable', 'play-tools answered 500') });
    const { submissionId } = await cancel(id);
    expect(cancels()).toHaveLength(1);
    expect(items(submissionId!)[0]).toMatchObject({ outcome: 'failed', errorCode: 'unavailable', support: expect.objectContaining({ action: 'cancel' }) });
    expect(rowOf(id).state).toBe('created');
    expect(staffRows()).toEqual(UNTOUCHED);

    onCancel = undefined;
    const retry = await service.retry(L, submissionId!, 'organizer');
    await service.idle();
    expect(cancels()).toHaveLength(2);
    expect(service.get(L, retry.submissionId)).toMatchObject({ status: 'succeeded', retryOf: submissionId });
  });

  it('records a refusal with support details; a 403 stops the job, and a 423 is locked', async () => {
    const id = created();
    onCancel = () => ({
      fail: new PokemonUpstreamError('refused', 'Cancelling a tournament: Invalid request.', {
        status: 400,
        upstream: { code: 'op.generic.bad_request', message: 'Invalid request.', correlationId: 'corr-1' },
      }),
    });
    const { submissionId } = await cancel(id);
    expect(items(submissionId!)[0]).toMatchObject({
      outcome: 'refused',
      errorCode: 'refused',
      support: {
        action: 'cancel',
        sentAt: clock.toISOString(),
        league: { displayId: 'L5012' },
        tournament: { displayId: '26-10-000001', name: 'Tuesday Cup', date: '2026-10-20' },
        professor: { playerId: OLIVE.professorPlayerId, name: OLIVE.professorName },
        status: 400,
        code: 'op.generic.bad_request',
        message: 'Invalid request.',
        correlationId: 'corr-1',
      },
    });

    onCancel = () => ({ fail: new PokemonUpstreamError('forbidden', 'Forbidden', { status: 403 }) });
    const forbidden = await cancel(id);
    expect(items(forbidden.submissionId!)[0]).toMatchObject({ outcome: 'refused', errorCode: 'forbidden' });
    expect(service.get(L, forbidden.submissionId!).status).toBe('failed');

    onCancel = () => ({ fail: new PokemonUpstreamError('tournament_locked', 'No longer modifiable.', { status: 423 }) });
    const locked = await cancel(id);
    expect(items(locked.submissionId!)[0]).toMatchObject({ outcome: 'failed', errorCode: 'tournament_locked' });
    expect(rowOf(id).state).toBe('created');
  });

  it('keeps play-tools’ own status on the row when the re-read after the 204 does not show it cancelled', async () => {
    const id = created();
    onCancel = () => 'ignored';
    const { submissionId } = await cancel(id);
    expect(items(submissionId!)[0]).toMatchObject({ outcome: 'cancelled', error: expect.stringContaining('sanctioned') });
    expect(rowOf(id)).toMatchObject({ state: 'cancelled', upstream_status: 'sanctioned' });
  });

  it('refuses a retry of an unconfirmed cancel once someone has registered, sending nothing more', async () => {
    const id = created();
    onCancel = () => ({ fail: new PokemonUpstreamError('unavailable', 'play-tools answered 500') });
    const { submissionId } = await cancel(id);
    upstream.state.participants.set(GUID, participants(OLIVE.professorPlayerId!, { players: 1 }));

    onCancel = undefined;
    const retry = await service.retry(L, submissionId!, 'organizer');
    await service.idle();

    expect(cancels()).toHaveLength(1);
    expect(items(retry.submissionId)[0]).toMatchObject({ outcome: 'failed', errorCode: 'confirmation_required' });
    expect(rowOf(id).state).toBe('created');
  });

  it('lets a retry of a confirmed cancel through without asking again', async () => {
    const id = created({ players: 1 });
    onCancel = () => ({ fail: new PokemonUpstreamError('unavailable', 'play-tools answered 500') });
    const { submissionId } = await cancel(id, { confirmation: '26-10-000001' });
    onCancel = undefined;
    const retry = await service.retry(L, submissionId!, 'organizer');
    await service.idle();
    expect(items(retry.submissionId)[0]).toMatchObject({ outcome: 'cancelled' });
  });

  it('is nothing_to_cancel for a retry of a job that cancelled it', async () => {
    const id = created();
    const { submissionId } = await cancel(id);
    await expect(service.retry(L, submissionId!, 'organizer')).rejects.toMatchObject({ code: 'nothing_to_cancel' });
  });

  it('on boot, a cancel in flight is unknown and the row untouched; a retry re-reads and finds it cancelled', async () => {
    const id = created();
    onCancel = async () => {
      await new Promise(() => {}); // the app dies mid-call, after play-tools took it
      return undefined;
    };
    const { submissionId } = await service.cancelTournament(L, { target: { kind: 'planned', id }, body: {}, startedBy: 'organizer' });
    await new Promise((r) => setImmediate(r));
    stub().applicationState = 'cancelled';

    const rebooted = build();
    expect(rebooted.recoverInterrupted()).toBe(1);
    expect(rebooted.get(L, submissionId!)).toMatchObject({ status: 'interrupted', counts: { failed: 1, skipped: 0 } });
    expect(items(submissionId!)[0]).toMatchObject({ outcome: 'unknown' });
    expect(rowOf(id).state).toBe('created');
    expect(staffRows()).toEqual(UNTOUCHED);

    onCancel = undefined;
    const retry = await rebooted.retry(L, submissionId!, 'organizer');
    await rebooted.idle();
    expect(rebooted.get(L, retry.submissionId).tournamentItems[0]).toMatchObject({ outcome: 'already_cancelled' });
    expect(cancels()).toHaveLength(1);
  });

  it('on boot, a cancel that never went out is skipped, also for a tournament no row holds', async () => {
    created();
    database.sqlite.prepare('delete from planned_tournament').run();
    onRead = (n) => (n === 2 ? new Promise(() => {}) : undefined); // the app dies during the job's own read
    const { submissionId } = await service.cancelTournament(L, { target: { kind: 'tournament', id: GUID }, body: {}, startedBy: 'organizer' });
    await new Promise((r) => setImmediate(r));

    const rebooted = build();
    expect(rebooted.recoverInterrupted()).toBe(1);
    expect(rebooted.get(L, submissionId!)).toMatchObject({ status: 'interrupted', counts: { failed: 0, skipped: 1 } });
    expect(items(submissionId!)[0]).toMatchObject({ outcome: 'skipped', plannedTournamentId: null, sentAt: null });
    expect(cancels()).toEqual([]);
    expect(staffRows()).toEqual(UNTOUCHED);
  });

  it('refuses while another job holds the lease, reading and writing nothing', async () => {
    const id = created();
    database.sqlite.prepare('insert into submission_lock (league_id, submission_id, expires_at) values (?, 999, ?)').run(L, clock.getTime() + 60_000);
    await expect(service.cancelTournament(L, { target: { kind: 'planned', id }, body: {}, startedBy: 'organizer' })).rejects.toMatchObject({
      code: 'submission_running',
    });
    expect(readCount).toBe(0);
    expect(rowOf(id).state).toBe('created');
  });

  it('refuses an already-cancelled apply when the lease is taken during its reads, writing nothing', async () => {
    const id = created();
    stub().applicationState = 'cancelled';
    onRead = () => {
      database.sqlite.prepare('insert or replace into submission_lock (league_id, submission_id, expires_at) values (?, 999, ?)').run(L, clock.getTime() + 60_000);
    };
    await expect(cancel(id)).rejects.toMatchObject({ code: 'submission_running' });
    expect(rowOf(id).state).toBe('created');
    expect(staffRows()).toEqual(UNTOUCHED);
  });

  it('reads the tournament after waiting its turn, so someone registering during the wait stops an unconfirmed cancel', async () => {
    service = build({ tournamentDelayMs: 60_000 });
    const id = created();
    await service.editTournaments(L, { target: { kind: 'planned', id }, body: ApplyBody.parse({ changes: { details: 'New' } }), startedBy: 'organizer' });
    await service.idle();
    onSleep = () => upstream.state.participants.set(GUID, participants(OLIVE.professorPlayerId!, { players: 1 }));

    const { submissionId } = await cancel(id);

    expect(cancels()).toEqual([]);
    expect(items(submissionId!)[0]).toMatchObject({ outcome: 'failed', errorCode: 'confirmation_required' });
  });

  it.each([
    ['a job', () => undefined],
    ['the already-cancelled path', () => (stub().applicationState = 'cancelled')],
  ])('refuses %s when the app starts shutting down during the reads, writing nothing', async (_what, setup) => {
    const id = created();
    setup();
    onRead = () => void service.shutdown();
    await expect(cancel(id)).rejects.toMatchObject({ code: 'shutting_down' });
    expect(jobs()).toEqual([]);
    expect(rowOf(id).state).toBe('created');
    expect(staffRows()).toEqual(UNTOUCHED);
  });

  it('keeps a cancel at least 2 s after an edit, whatever the setting', async () => {
    service = build({ tournamentDelayMs: 0 });
    const id = created();
    await service.editTournaments(L, { target: { kind: 'planned', id }, body: ApplyBody.parse({ changes: { details: 'New' } }), startedBy: 'organizer' });
    await service.idle();
    await cancel(id);
    expect(writes.map((w) => [w.kind, w.at - writes[0]!.at])).toEqual([
      ['edit', 0],
      ['cancel', 2_000],
    ]);
  });
});
