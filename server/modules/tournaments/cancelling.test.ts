import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EditTarget } from '../../../shared/schemas/tournaments';
import { localInstant } from '../../../shared/time/local-time';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import { PokemonUpstreamError } from '../pokemon/ports/errors';
import type { TournamentDetails } from '../pokemon/ports/play-tools-gateway';
import { createRosterService } from '../roster/service';
import { createStaffingService } from '../staffing/service';
import type { CancelItem } from './cancelling';
import { type TournamentsService, createTournamentsService } from './service';
import { BROCK, OLIVE, VENUE, participants, stubPlayTools, templateBody, upstreamTournament } from './test-helpers';

// The tournaments module's side of Cancel… (#94, ADR-0010 decision 8): the confirm preview from a fresh read as the
// organizer, the apply's refusals and typed confirmation, each job item's fresh read, and the local follow-ups. The job
// itself is the submission module's.

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const TZ = 'America/Chicago';
/** Wednesday 2026-10-14, noon in Chicago. */
const NOON_WED = new Date('2026-10-14T17:00:00Z');
const GUID = 'aaaaaaaa-0000-4000-8000-000000000001';
const START = localInstant('2026-10-20', '18:00', TZ);

let database: OpenDatabase;
let upstream: ReturnType<typeof stubPlayTools>;
let service: TournamentsService;
let now: Date;

beforeEach(() => {
  database = openDatabase(':memory:');
  migrateDatabase(database.db, MIGRATIONS_DIR);
  upstream = stubPlayTools();
  upstream.state.professors.push({ ...BROCK });
  now = NOON_WED;
  const staffing = createStaffingService({
    db: database.db,
    roster: createRosterService({ db: database.db }),
    connections: upstream.connections,
    staffGateway: () => {
      throw new Error('a cancel never calls staffing upstream');
    },
    timeZone: TZ,
    now: () => now,
  });
  service = createTournamentsService({
    db: database.db,
    connections: upstream.connections,
    gateway: upstream.gateway,
    staffing,
    timeZone: TZ,
    now: () => now,
  });
});
afterEach(() => database.close());

type Row = { id: number; state: string; tournament_id: string | null; display_id: string | null; upstream_status: string | null };
const rowOf = (id: number) => database.sqlite.prepare('select * from planned_tournament where id = ?').get(id) as Row;
const setRow = (id: number, set: string) => database.sqlite.prepare(`update planned_tournament set ${set} where id = ?`).run(id);
const calls = () => upstream.state.calls.filter((c) => !c.startsWith('listSeries'));
const stub = () => upstream.state.tournaments.find((t) => t.id === GUID)!;
const byPlanned = (id: number): EditTarget => ({ kind: 'planned', id });
const byGuid = (id = GUID): EditTarget => ({ kind: 'tournament', id });

const details: Partial<TournamentDetails> = { venue: { id: VENUE.id, timeZone: TZ }, editableUntil: new Date(START.getTime() + 90 * 86_400_000) };

/** A planned row created in play-tools as Olive's tournament, listing `players` and `staff`. */
function created(counts: { players?: number; staff?: number } = {}, opts: Parameters<typeof upstreamTournament>[2] = {}) {
  const t = service.createTemplate(L, templateBody({ name: 'Tuesday Cup', type: { kind: 'custom' } }));
  const planned = service.createPlanned(L, { templateId: t.id, localDate: '2026-10-20' });
  const id = planned.plannedId!;
  upstream.state.tournaments.push(upstreamTournament(GUID, START.toISOString(), { name: 'Tuesday Cup', displayId: '26-10-000001', details, ...opts }));
  upstream.state.participants.set(GUID, participants(OLIVE.professorPlayerId!, counts));
  setRow(id, `state = 'created', tournament_id = '${GUID}'`);
  upstream.state.calls.length = 0;
  return id;
}

function seedStaff(tournamentId: string) {
  for (const [playerId, state, recordId] of [
    ['00111', 'pending', null],
    ['00222', 'assigned', 'rec-222'],
  ] as const) {
    database.sqlite.prepare("insert or ignore into player (player_id, display_name, first_seen_at) values (?, 'Staffer', 0)").run(playerId);
    database.sqlite
      .prepare(
        `insert into staff_assignment (league_id, session_date, tournament_id, tournament_label, player_id, role, state, record_id, created_by, created_at)
         values (?, '2026-10-20', ?, 'Tuesday Cup', ?, 'judge', ?, ?, 'organizer', 0)`,
      )
      .run(L, tournamentId, playerId, state, recordId);
  }
}
const staffRows = () => database.sqlite.prepare('select player_id, state, removed_at from staff_assignment order by player_id').all();

async function refusal(run: Promise<unknown>) {
  try {
    await run;
  } catch (err) {
    return err as { code: string; details: Record<string, unknown> };
  }
  throw new Error('expected a refusal');
}

describe('the confirm preview', () => {
  it('names the tournament and counts who it lists, the same by planned id or guid, from fresh reads as the organizer', async () => {
    const id = created({ players: 3, staff: 2 });

    const a = await service.cancelling.preview(L, byPlanned(id));
    const b = await service.cancelling.preview(L, byGuid());

    expect(a).toEqual({
      target: { plannedId: id, tournamentId: GUID, displayId: '26-10-000001' },
      name: 'Tuesday Cup',
      localDate: '2026-10-20',
      startTime: '18:00',
      organizer: { playerId: OLIVE.professorPlayerId, name: OLIVE.professorName },
      upstreamStatus: 'sanctioned',
      players: 3,
      staff: 2,
      cancellable: true,
      reason: null,
      closesOn: '2027-01-18',
      confirmRequired: true,
      confirmWith: '26-10-000001',
    });
    expect(b).toEqual(a);
    expect(calls()).toEqual(['getTournament@1', 'listTournamentParticipants@1', 'getTournament@1', 'listTournamentParticipants@1']);
  });

  it('asks for no confirmation when only the organizer is listed, and for one when a single staffer is', async () => {
    const id = created();
    expect(await service.cancelling.preview(L, byPlanned(id))).toMatchObject({ players: 0, staff: 0, confirmRequired: false, confirmWith: null });
    upstream.state.participants.set(GUID, participants(OLIVE.professorPlayerId!, { staff: 1 }));
    expect(await service.cancelling.preview(L, byPlanned(id))).toMatchObject({ staff: 1, confirmRequired: true });
  });

  it("reads a guid no row holds as each professor in turn: Brock's tournament is read as Brock", async () => {
    upstream.state.tournaments.push(upstreamTournament(GUID, START.toISOString(), { organizer: BROCK.professorPlayerId!, details }));
    upstream.state.participants.set(GUID, participants(BROCK.professorPlayerId!));
    upstream.state.failNext.set('getTournament@1', new PokemonUpstreamError('not_found', 'not yours'));

    const preview = await service.cancelling.preview(L, byGuid());

    expect(preview.organizer.playerId).toBe(BROCK.professorPlayerId);
    expect(preview.target.plannedId).toBeNull();
    expect(upstream.state.calls).toEqual(['getTournament@1', 'getTournament@2', 'listTournamentParticipants@2']);
  });

  it("is not_found for a guid nobody can read and for another league's tournament, and organizer_not_connected when its organizer left", async () => {
    expect((await refusal(service.cancelling.preview(L, byGuid())))?.code).toBe('not_found');

    upstream.state.tournaments.push(upstreamTournament(GUID, START.toISOString(), { groupId: 'another-league', details }));
    expect((await refusal(service.cancelling.preview(L, byGuid())))?.code).toBe('not_found');
    expect((await refusal(service.cancelling.prepare(L, byGuid(), {})))?.code).toBe('not_found');

    (stub() as { groupId: string }).groupId = 'group-1';
    (stub() as { organizer: string }).organizer = '9999993';
    expect((await refusal(service.cancelling.preview(L, byGuid())))?.code).toBe('organizer_not_connected');
    expect(upstream.state.cancels).toEqual([]);
  });

  it.each([
    ['sanctioned', 'sanctioned', 'pending', { cancellable: true, reason: null }],
    ['approval-pending', 'approval-pending', 'pending', { cancellable: true, reason: null }],
    ['sanctioning-error', 'sanctioning-error', 'pending', { cancellable: true, reason: null }],
    ['cancelled', 'cancelled', 'pending', { cancellable: false, reason: 'already_cancelled' }],
    ['sanctioned', 'complete', 'pending', { cancellable: false, reason: 'tournament_locked' }],
    ['sanctioned', 'sanctioned', 'completed', { cancellable: false, reason: 'tournament_locked' }],
  ])('reads application state %s, status %s, activity %s as %j', async (applicationState, status, activityState, expected) => {
    const id = created({}, { status, applicationState, details: { ...details, activityState } });
    expect(await service.cancelling.preview(L, byPlanned(id))).toMatchObject(expected);
  });

  it('locks a tournament 91 days past its start', async () => {
    const id = created();
    now = new Date(START.getTime() + 91 * 86_400_000);
    expect(await service.cancelling.preview(L, byPlanned(id))).toMatchObject({ cancellable: false, reason: 'tournament_locked' });
  });

  it.each(['planned', 'failed', 'skipped'])('refuses a %s row that never reached play-tools, with no call', async (state) => {
    const id = created();
    setRow(id, `state = '${state}', tournament_id = null`);
    expect(await refusal(service.cancelling.preview(L, byPlanned(id)))).toMatchObject({ code: 'not_in_play_tools', details: { state } });
    expect(await refusal(service.cancelling.prepare(L, byPlanned(id), {}))).toMatchObject({ code: 'not_in_play_tools' });
    expect(upstream.state.calls).toEqual([]);
  });

  it.each(['creating', 'unknown'])('refuses a %s row until its create settles, with no call', async (state) => {
    const id = created();
    setRow(id, `state = '${state}'`);
    expect(await refusal(service.cancelling.preview(L, byPlanned(id)))).toMatchObject({ code: 'not_editable', details: { state } });
    expect(upstream.state.calls).toEqual([]);
  });

  it('refuses a row skipped while its create may have landed until it is linked, then cancels it like any other (#125)', async () => {
    const id = created();
    setRow(id, "state = 'skipped', skipped_while_unknown = 1, tournament_id = null");
    expect(await refusal(service.cancelling.preview(L, byPlanned(id)))).toMatchObject({ code: 'not_editable', details: { state: 'skipped', skippedWhileUnknown: true } });
    expect(upstream.state.calls).toEqual([]);

    setRow(id, `tournament_id = '${GUID}'`);
    expect(await service.cancelling.preview(L, byPlanned(id))).toMatchObject({ target: { plannedId: id, tournamentId: GUID }, cancellable: true });
  });

  it.each(['cancelled', 'skipped'])('reads a %s row that holds a guid like a created one', async (state) => {
    const id = created();
    setRow(id, `state = '${state}'`);
    expect(await service.cancelling.preview(L, byPlanned(id))).toMatchObject({ target: { plannedId: id, tournamentId: GUID }, cancellable: true });
  });

  it('is not_found for a created row whose tournament play-tools no longer has', async () => {
    const id = created();
    upstream.state.tournaments.length = 0;
    expect((await refusal(service.cancelling.preview(L, byPlanned(id))))?.code).toBe('not_found');
  });
});

describe('the apply: refusals and the typed confirmation', () => {
  it.each([
    ['missing', {}],
    ['wrong', { confirmation: '26-10-000002' }],
    ['with a space', { confirmation: ' 26-10-000001' }],
    ['as the date instead', { confirmation: '2026-10-20' }],
  ])('refuses a confirmation %s when anyone is listed', async (_what, body) => {
    const id = created({ players: 1 });
    expect(await refusal(service.cancelling.prepare(L, byPlanned(id), body))).toMatchObject({ code: 'confirmation_mismatch', details: { required: true } });
  });

  it('takes the exact display id, and marks the item confirmed', async () => {
    const id = created({ players: 1 });
    expect(await service.cancelling.prepare(L, byPlanned(id), { confirmation: '26-10-000001' })).toEqual({
      kind: 'cancel',
      item: { plannedId: id, tournamentId: GUID, label: 'Tuesday Cup · 2026-10-20', professorPlayerId: OLIVE.professorPlayerId, confirmed: true },
    });
  });

  it('takes the local date when play-tools gives no display id', async () => {
    const id = created({ players: 1 }, { displayId: null });
    expect((await service.cancelling.prepare(L, byPlanned(id), { confirmation: '2026-10-20' })).kind).toBe('cancel');
  });

  it('needs and ignores no confirmation when nobody is listed: the item is unconfirmed', async () => {
    const id = created();
    const plan = await service.cancelling.prepare(L, byPlanned(id), { confirmation: 'anything' });
    expect(plan).toMatchObject({ kind: 'cancel', item: { confirmed: false } });
  });

  it('is already_cancelled for a tournament play-tools already cancelled, after the confirmation', async () => {
    const id = created({ players: 2 }, { status: 'cancelled', applicationState: 'cancelled' });
    expect((await refusal(service.cancelling.prepare(L, byPlanned(id), {})))?.code).toBe('confirmation_mismatch');
    expect(await service.cancelling.prepare(L, byPlanned(id), { confirmation: '26-10-000001' })).toMatchObject({ kind: 'already_cancelled' });
  });

  it('refuses a tournament play-tools no longer lets a professor cancel, with its status', async () => {
    const id = created({}, { status: 'complete' });
    expect(await refusal(service.cancelling.prepare(L, byPlanned(id), {}))).toMatchObject({ code: 'tournament_locked', details: { status: 'complete' } });
  });

  it('changes nothing locally, whatever it answers', async () => {
    const id = created({ players: 1 });
    seedStaff(GUID);
    const before = staffRows();
    await refusal(service.cancelling.prepare(L, byPlanned(id), {}));
    await service.cancelling.prepare(L, byPlanned(id), { confirmation: '26-10-000001' });
    expect(rowOf(id).state).toBe('created');
    expect(staffRows()).toEqual(before);
    expect(upstream.state.cancels).toEqual([]);
  });
});

describe("a job item's fresh read", () => {
  const item = (over: Partial<CancelItem> = {}): CancelItem => ({
    plannedId: null,
    tournamentId: GUID,
    label: 'Tuesday Cup · 2026-10-20',
    professorPlayerId: OLIVE.professorPlayerId!,
    confirmed: true,
    ...over,
  });

  it('sends when play-tools still lets it be cancelled', async () => {
    created({ players: 2 });
    expect(await service.cancelling.readItem(L, item())).toMatchObject({ kind: 'send', connectionId: OLIVE.id });
    expect(upstream.state.calls).toEqual(['getTournament@1']);
  });

  it('is already_cancelled, locked or gone without sending', async () => {
    created();
    stub().applicationState = 'cancelled';
    expect(await service.cancelling.readItem(L, item())).toMatchObject({ kind: 'already_cancelled' });
    stub().applicationState = 'sanctioned';
    (stub() as { status: string }).status = 'complete';
    expect(await service.cancelling.readItem(L, item())).toMatchObject({ kind: 'fail', code: 'tournament_locked' });
    upstream.state.tournaments.length = 0;
    expect(await service.cancelling.readItem(L, item())).toMatchObject({ kind: 'fail', code: 'unknown_tournament' });
  });

  it('fails an unconfirmed item once anyone is listed, and sends it while nobody is', async () => {
    created();
    expect(await service.cancelling.readItem(L, item({ confirmed: false }))).toMatchObject({ kind: 'send' });
    upstream.state.participants.set(GUID, participants(OLIVE.professorPlayerId!, { players: 1 }));
    expect(await service.cancelling.readItem(L, item({ confirmed: false }))).toMatchObject({ kind: 'fail', code: 'confirmation_required' });
  });

  it('stops the job when the organizer is gone or must reconnect', async () => {
    created();
    upstream.state.professors[0]!.status = 'needs_reconnect';
    expect((await refusal(service.cancelling.readItem(L, item())))?.code).toBe('needs_reconnect');
    upstream.state.professors.shift();
    expect((await refusal(service.cancelling.readItem(L, item())))?.code).toBe('not_connected');
  });
});

describe('the local follow-ups', () => {
  it("marks the planned row cancelled and drops or tombstones the tournament's staff, in one go", () => {
    const id = created();
    seedStaff(GUID);

    expect(service.cancelling.recordCancelled(L, { plannedId: id, tournamentId: GUID })).toEqual({ dropped: 1, removed: 1 });

    expect(rowOf(id)).toMatchObject({ state: 'cancelled', upstream_status: 'cancelled' });
    expect(staffRows()).toEqual([{ player_id: '00222', state: 'removing', removed_at: Math.floor(now.getTime() / 1000) }]);
  });

  it('touches only staff for a tournament no row holds', () => {
    seedStaff(GUID);
    expect(service.cancelling.recordCancelled(L, { plannedId: null, tournamentId: GUID })).toEqual({ dropped: 1, removed: 1 });
  });

  it("records the reconcile's status over the follow-ups", () => {
    const id = created();
    service.cancelling.recordCancelled(L, { plannedId: id, tournamentId: GUID });
    service.cancelling.recordReconciled(L, id, { displayId: '26-10-000001', status: 'sanctioned' });
    expect(rowOf(id)).toMatchObject({ state: 'cancelled', upstream_status: 'sanctioned', display_id: '26-10-000001' });
  });
});
