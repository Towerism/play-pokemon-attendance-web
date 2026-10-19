import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { silentLogger } from '@towerism/selfhost-kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BIRTHDATE, tomTdf } from '../../../shared/tdf/__fixtures__/tom';
import type { PlayerId, SessionDate } from '../../../shared/types/ids';
import { localInstant } from '../../../shared/time/local-time';
import { tdfVault } from '../../bootstrap/vaults';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import { type SightingsService, createSightingsService } from '../metrics/sightings';
import { PokemonUpstreamError } from '../pokemon/ports/errors';
import type { ResultsError, ResultsUpload, TournamentParticipant } from '../pokemon/ports/play-tools-gateway';
import { type RosterService, createRosterService } from '../roster/service';
import { type SessionsService, createSessionsService } from '../sessions/service';
import { type TdfImportService, createTdfImportService, createTdfUploadReferrer } from '../sessions/tdf-import';
import { type StaffingService, createStaffingService } from '../staffing/service';
import { type TdfArchiveService, createTdfArchiveService } from '../tdf-archive/service';
import { TournamentsError } from '../tournaments/errors';
import { type TournamentResults, createResultUploadReferrer, createTournamentResults } from '../tournaments/results';
import { OLIVE, stubPlayTools, upstreamTournament } from '../tournaments/test-helpers';
import type { PlaySessionResolver } from './resolve';
import { type SubmissionService, createSubmissionService } from './service';
import { OWNER, professorActor } from '../pokemon/test-connections';

// The `tdf_upload` job (#96, ADR-0011) and Remove from staff's removal-only staff job on the submission rails. The
// send is `validateResults`: every refusal asserts it was never called, and the happy path that it was called once,
// with the archived file, before exactly one confirm. Every wait is the fake clock's; reads and sends are gated.

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const TZ = 'America/Chicago';
const DATE = '2026-10-14' as SessionDate;
const GUID = 'aaaaaaaa-0000-4000-8000-000000000001';
const GUID2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const DISPLAY_ID = '26-10-000123';
const ORGANIZER = OLIVE.professorPlayerId!;
const START = localInstant(DATE, '18:00', TZ);
const PLAYERS = [
  { userid: '1234567', first: 'Ash', last: 'Ketchum' },
  { userid: '2345678', first: 'Misty', last: 'Waterflower' },
];
const file = (o: Parameters<typeof tomTdf>[0] = {}) =>
  tomTdf({ players: PLAYERS, idElement: `<id>${DISPLAY_ID}</id>`, organizerElement: `<organizer popid="${ORGANIZER}" name="Olive Organizer"/>`, ...o });

let database: OpenDatabase;
let roster: RosterService;
let sightings: SightingsService;
let sessions: SessionsService;
let archive: TdfArchiveService;
let attendance: TdfImportService;
let staffing: StaffingService;
let upstream: ReturnType<typeof stubPlayTools>;
let results: TournamentResults;
let service: SubmissionService;
let clock: Date;
/** Tournament guid → activity state play-tools reports. */
let activity: Map<string, string>;
let uploads: ({ -readonly [K in keyof ResultsUpload]: ResultsUpload[K] } & { displayId: string })[];
/** Every send, in order: validate, confirm or a staff delete, by the fake clock. */
let sent: { at: number; what: 'validate' | 'confirm' | 'unassign'; as: number; args: unknown[] }[];
/** play-tools' errors for the next validate. */
let validateErrors: ResultsError[];
/** Decides each send before it is answered: throw to fail it, or hold it with a promise. */
let onSend: ((what: 'validate' | 'confirm' | 'unassign', n: number) => unknown) | undefined;
/** Runs before each tournament read, numbered from 1. */
let onRead: ((n: number) => unknown) | undefined;
let readCount: number;
/** Which tournament leases are still live (ADR-0015 §5). */
let live: Set<number>;

const noResolver: PlaySessionResolver = { resolve: () => Promise.reject(new Error('never')), find: () => Promise.reject(new Error('never')) };
const noAttendance = {
  listAttendance: () => Promise.reject(new Error('never')),
  addAttendanceBulk: () => Promise.reject(new Error('never')),
  removeAttendance: () => Promise.reject(new Error('never')),
};
const person = (playerId: string, role: string | null): TournamentParticipant => ({
  recordId: `rec-${playerId}`,
  playerId: playerId as PlayerId,
  role,
  isStaff: role !== null,
  name: `Person ${playerId}`,
});
const setPeople = (guid: string, ...people: TournamentParticipant[]) => upstream.state.participants.set(guid, [person(ORGANIZER, 'organizer'), ...people]);

/** play-tools as one connection: tournament reads numbered, sends logged and gated. */
function playTools(connectionId: number) {
  const base = upstream.gateway(connectionId);
  const logSend = async (what: 'validate' | 'confirm' | 'unassign', args: unknown[]) => {
    sent.push({ at: clock.getTime(), what, as: connectionId, args });
    await onSend?.(what, sent.filter((s) => s.what === what).length);
  };
  return {
    ...base,
    async getTournament(id: string) {
      await onRead?.(++readCount);
      const t = await base.getTournament(id);
      return { ...t, activityState: activity.get(id) ?? 'pending', organizerName: 'Olive Organizer' };
    },
    async validateResults(displayId: string, tdf: string) {
      await logSend('validate', [displayId, tdf]);
      const uploadId = `upload-${sent.length}`;
      uploads.push({ uploadId, accepted: false, errors: validateErrors, uploadedAt: clock, displayId });
      const errors = validateErrors;
      validateErrors = [];
      return { uploadId, errors };
    },
    async confirmResults(uploadId: string, tournamentId: string) {
      await logSend('confirm', [uploadId, tournamentId]);
      const u = uploads.find((x) => x.uploadId === uploadId);
      if (u) u.accepted = true;
      activity.set(tournamentId, 'upload_in_progress');
      return 'confirmed' as const;
    },
    async listResultsUploads(displayId: string) {
      return uploads.filter((u) => u.displayId === displayId).map(({ displayId: _d, ...u }) => u);
    },
    listStaffRoles: () => [{ code: 'judge' as const, label: 'Judge' }],
    async unassignStaff(tournamentId: string, recordId: string, playerId: PlayerId) {
      await logSend('unassign', [tournamentId, recordId, playerId]);
      const people = upstream.state.participants.get(tournamentId) ?? [];
      if (!people.some((p) => p.recordId === recordId)) return 'not_found' as const;
      upstream.state.participants.set(
        tournamentId,
        people.filter((p) => p.recordId !== recordId),
      );
      return 'removed' as const;
    },
  };
}

function build(): SubmissionService {
  return createSubmissionService({
    db: database.db,
    sessions,
    roster,
    sightings,
    connections: upstream.connections,
    gateway: () => noAttendance,
    staffGateway: (connectionId) => playTools(connectionId ?? 0) as never,
    tournamentGateway: (connectionId) => playTools(connectionId) as never,
    staffing,
    tournaments: { creation: {} as never, createThrough: () => Promise.reject(new Error('never')), results },
    resolver: noResolver,
    timeZone: TZ,
    now: () => clock,
    sleep: async (ms, signal) => {
      if (signal.aborted) throw signal.reason;
      clock = new Date(clock.getTime() + ms);
    },
    leases: { isLive: (leaseId) => live.has(leaseId), endLeasesForTournament: () => {} },
    log: silentLogger,
  });
}

beforeEach(() => {
  database = openDatabase(':memory:');
  migrateDatabase(database.db, MIGRATIONS_DIR);
  roster = createRosterService({ db: database.db });
  roster.ensurePlayers(L, PLAYERS.map((p) => ({ playerId: p.userid as PlayerId, name: `${p.first} ${p.last}` })));
  sightings = createSightingsService({ db: database.db });
  sessions = createSessionsService({ db: database.db, roster, sightings });
  clock = new Date('2026-10-15T15:00:00Z');
  upstream = stubPlayTools();
  for (const [guid, displayId] of [
    [GUID, DISPLAY_ID],
    [GUID2, '26-10-000124'],
  ] as const) {
    upstream.state.tournaments.push(upstreamTournament(displayId.slice(-6), START.toISOString(), { id: guid, displayId, editableUntil: new Date(START.getTime() + 90 * 86_400_000) }));
    setPeople(guid);
  }
  activity = new Map();
  uploads = [];
  sent = [];
  validateErrors = [];
  onSend = undefined;
  onRead = undefined;
  readCount = 0;
  live = new Set();
  archive = createTdfArchiveService({
    db: database.db,
    vault: tdfVault(randomBytes(32).toString('base64')),
    referrers: () => [createTdfUploadReferrer(database.db), createResultUploadReferrer(database.db)],
    log: silentLogger,
    now: () => clock,
  });
  attendance = createTdfImportService({ db: database.db, roster, sightings, archive, now: () => clock });
  staffing = createStaffingService({
    db: database.db,
    roster,
    connections: upstream.connections,
    staffGateway: () => playTools(OLIVE.id) as never,
    timeZone: TZ,
    now: () => clock,
  });
  results = createTournamentResults({
    db: database.db,
    connections: upstream.connections,
    gateway: (c) => playTools(c),
    names: { fullNameOf: () => 'Olive Organizer', saveFullName: () => undefined },
    archive,
    attendance,
    roster,
    timeZone: TZ,
    now: () => clock,
  });
  service = build();
});
afterEach(() => database.close());

const preview = (content = file(), guid = GUID) => results.preview(L, DATE, guid, { filename: 'cup.tdf', content }, OWNER);
async function upload(opts: { content?: string; importAttendance?: boolean; guid?: string; beforeJob?: () => void } = {}) {
  const p = await preview(opts.content, opts.guid);
  opts.beforeJob?.();
  const { submissionId } = await service.uploadResults(L, {
    date: DATE,
    tournamentId: opts.guid ?? GUID,
    uploadId: p.uploadId,
    body: { importAttendance: opts.importAttendance ?? true, acknowledgedWarnings: p.fingerprint! },
    actor: OWNER,
  });
  await service.idle();
  return { p, submissionId, job: service.get(L, submissionId) };
}
type UploadRow = { state: string; error_code: string | null; upstream_upload_id: string | null; upstream_errors: string; acknowledged_by: string | null };
const uploadRow = (id: number) => database.sqlite.prepare('select * from tournament_result_upload where id = ?').get(id) as UploadRow;
const sends = (what: string) => sent.filter((s) => s.what === what);
const listedForDate = () => database.sqlite.prepare('select count(*) from session_player').pluck().get() as number;
const lock = () => database.sqlite.prepare('select count(*) from submission_lock').pluck().get() as number;
const refusal = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(TournamentsError);
  return err as TournamentsError;
};

describe('the send', () => {
  it('validates the archived file once, confirms once, imports attendance, and frees the lease', async () => {
    const { p, job } = await upload();

    expect(sends('validate')).toEqual([expect.objectContaining({ as: OLIVE.id, args: [DISPLAY_ID, file()] })]);
    expect(sends('confirm')).toEqual([expect.objectContaining({ args: ['upload-1', GUID] })]);
    expect(job).toMatchObject({ kind: 'tdf_upload', status: 'succeeded', tournamentItems: [expect.objectContaining({ outcome: 'processing', tournamentId: GUID })] });
    expect(job.playSessionLabel).toContain(DATE);
    expect(uploadRow(p.uploadId)).toMatchObject({ state: 'processing', upstream_upload_id: 'upload-1', acknowledged_by: 'organizer' });
    expect(listedForDate()).toBe(2);
    expect(lock()).toBe(0);
    expect(archive.list(L)[0]!.keptFor).toEqual(['attendance', 'results']);
  });

  it('leaves attendance alone when not ticked', async () => {
    await upload({ importAttendance: false });
    expect(listedForDate()).toBe(0);
  });

  it('refuses a fingerprint that is not the preview’s: no job, nothing sent', async () => {
    setPeople(GUID, person('1234567', 'judge'));
    const p = await preview();
    const err = await refusal(
      service.uploadResults(L, { date: DATE, tournamentId: GUID, uploadId: p.uploadId, body: { importAttendance: true, acknowledgedWarnings: 'a'.repeat(64) }, actor: OWNER }),
    );
    expect(err.code).toBe('warnings_not_acknowledged');
    expect(service.list(L)).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('refuses while another job holds the lease, recording nothing', async () => {
    const p = await preview();
    database.sqlite.prepare('insert into submission_lock (league_id, submission_id, expires_at) values (?, 999, ?)').run(L, clock.getTime() + 600_000);
    await expect(
      service.uploadResults(L, { date: DATE, tournamentId: GUID, uploadId: p.uploadId, body: { importAttendance: true, acknowledgedWarnings: p.fingerprint! }, actor: OWNER }),
    ).rejects.toMatchObject({ code: 'submission_running' });
    expect(uploadRow(p.uploadId).state).toBe('previewed');
  });

  it('stops before the send when the warnings changed since the dialog', async () => {
    const { p, job } = await upload({ beforeJob: () => (onRead = () => setPeople(GUID, person('2345678', 'judge'))) });
    expect(sends('validate')).toEqual([]);
    expect(job).toMatchObject({ status: 'failed', tournamentItems: [expect.objectContaining({ outcome: 'warnings_changed' })] });
    expect(uploadRow(p.uploadId).state).toBe('warnings_changed');
    expect(listedForDate()).toBe(0);
  });

  it('stops before the send when the tournament can no longer take an upload', async () => {
    const { p, job } = await upload({ beforeJob: () => (onRead = () => setPeople(GUID, person('8000', null))) });
    expect(sent).toEqual([]);
    expect(job.tournamentItems[0]).toMatchObject({ outcome: 'refused', errorCode: 'results_already_uploaded' });
    expect(uploadRow(p.uploadId)).toMatchObject({ state: 'failed', error_code: 'results_already_uploaded' });
    expect(listedForDate()).toBe(0);
  });

  it('stops before the send when the organizer must reconnect', async () => {
    const p = await preview();
    upstream.state.professors[0] = { ...upstream.state.professors[0]!, status: 'needs_reconnect' };
    await service.uploadResults(L, { date: DATE, tournamentId: GUID, uploadId: p.uploadId, body: { importAttendance: true, acknowledgedWarnings: p.fingerprint! }, actor: OWNER });
    await service.idle();
    expect(sent).toEqual([]);
    expect(uploadRow(p.uploadId)).toMatchObject({ state: 'failed', error_code: 'needs_reconnect' });
  });

  it('does not confirm a file play-tools does not accept, and keeps its errors and support details', async () => {
    validateErrors = [{ code: 'ORGANIZER_ID_MISMATCH', message: "The file's organizer isn't the tournament's.", detail: '1 !== 2' }];
    const { p, job } = await upload();

    expect(sends('validate')).toHaveLength(1);
    expect(sends('confirm')).toEqual([]);
    const item = job.tournamentItems[0]!;
    expect(item).toMatchObject({ outcome: 'not_accepted', error: expect.stringContaining('Pokémon support can access the file') });
    expect(item.support).toMatchObject({ action: 'upload', uploadGuid: 'upload-1', errors: ['ORGANIZER_ID_MISMATCH'], tournament: { displayId: DISPLAY_ID } });
    expect(JSON.stringify(item.support)).not.toMatch(/Ash|Ketchum|1234567/);
    expect(uploadRow(p.uploadId)).toMatchObject({ state: 'not_accepted' });
    expect(JSON.parse(uploadRow(p.uploadId).upstream_errors)).toEqual([expect.objectContaining({ code: 'ORGANIZER_ID_MISMATCH' })]);
    expect(listedForDate()).toBe(2);
    expect(job.status).toBe('failed');
  });

  it.each([
    ['a 503', new PokemonUpstreamError('unavailable', 'play-tools answered 503.', { status: 503 })],
    ['a timeout', new PokemonUpstreamError('unavailable', 'Validating a TDF timed out.')],
  ])('ends validate_unknown after %s: no confirm, no second validate, lease free', async (_label, err) => {
    onSend = (what) => {
      if (what === 'validate') throw err;
    };
    const { p, job } = await upload();
    expect(sends('validate')).toHaveLength(1);
    expect(sends('confirm')).toEqual([]);
    expect(job.tournamentItems[0]).toMatchObject({ outcome: 'validate_unknown' });
    expect(uploadRow(p.uploadId).state).toBe('validate_unknown');
    expect(lock()).toBe(0);
  });

  it('fails a refused validate with its support details', async () => {
    onSend = (what) => {
      if (what === 'validate') throw new PokemonUpstreamError('refused', 'Bad file.', { status: 400, upstream: { code: 'op.x', message: 'Bad', correlationId: 'corr-1' } });
    };
    const { p, job } = await upload();
    expect(job.tournamentItems[0]).toMatchObject({ outcome: 'refused', errorCode: 'refused', support: expect.objectContaining({ correlationId: 'corr-1', action: 'upload' }) });
    expect(uploadRow(p.uploadId)).toMatchObject({ state: 'failed', error_code: 'refused' });
  });

  it('settles a confirm 5xx by one read: landed is processing', async () => {
    onSend = (what) => {
      if (what === 'confirm') {
        activity.set(GUID, 'upload_in_progress');
        throw new PokemonUpstreamError('unavailable', '502');
      }
    };
    const { p, job } = await upload();
    expect(sends('confirm')).toHaveLength(1);
    expect(job.tournamentItems[0]!.outcome).toBe('processing');
    expect(uploadRow(p.uploadId).state).toBe('processing');
  });

  it('settles a confirm 5xx by one read: not landed is failed, never sent again', async () => {
    onSend = (what) => {
      if (what === 'confirm') throw new PokemonUpstreamError('unavailable', '502');
    };
    const { p, job } = await upload();
    expect(sends('confirm')).toHaveLength(1);
    expect(job.tournamentItems[0]).toMatchObject({ outcome: 'failed', errorCode: 'confirm_not_landed' });
    expect(uploadRow(p.uploadId)).toMatchObject({ state: 'failed', error_code: 'confirm_not_landed' });
  });

  it('ends partial when the attendance import fails after a confirmed send', async () => {
    const p = await preview();
    database.sqlite.prepare('delete from tdf_upload').run();
    await service.uploadResults(L, { date: DATE, tournamentId: GUID, uploadId: p.uploadId, body: { importAttendance: true, acknowledgedWarnings: p.fingerprint! }, actor: OWNER });
    await service.idle();
    const job = service.list(L)[0]!;
    expect(job.status).toBe('partial');
    expect(service.get(L, job.id).tournamentItems[0]).toMatchObject({ outcome: 'processing', error: expect.stringContaining('attendance not imported') });
  });

  it('spaces a send at least 2 s after the league’s previous tournament write', async () => {
    await upload();
    await upload({ guid: GUID2, content: file({ idElement: '<id>26-10-000124</id>' }) });
    const [first, second] = sends('validate');
    expect(second!.at - first!.at).toBeGreaterThanOrEqual(2_000);
  });

  it('never puts a birthdate or the file in an item, event or the job', async () => {
    const { submissionId, job } = await upload();
    const all = JSON.stringify([job, service.events(L, submissionId)]);
    expect(all).not.toContain(BIRTHDATE);
    expect(all).not.toContain('<tournament');
  });
});

describe('never sent again on its own', () => {
  it('refuses History’s retry or resume: Upload again… only', async () => {
    const { submissionId } = await upload();
    expect((await refusal(service.retry(L, submissionId, OWNER))).code).toBe('use_upload_again');
  });

  async function crashAt(where: 'read' | 'validate' | 'confirm') {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let arrived!: () => void;
    const arrival = new Promise<void>((r) => (arrived = r));
    const p = await preview();
    readCount = 0;
    if (where === 'read') {
      onRead = (n) => {
        if (n === 1) {
          arrived();
          return held;
        }
      };
    } else {
      onSend = (what) => {
        if (what === where) {
          arrived();
          return held.then(() => {
            throw new Error('the process died');
          });
        }
      };
    }
    const { submissionId } = await service.uploadResults(L, {
      date: DATE,
      tournamentId: GUID,
      uploadId: p.uploadId,
      body: { importAttendance: true, acknowledgedWarnings: p.fingerprint! },
      actor: OWNER,
    });
    await arrival;
    // A new process on the same database boots while the old one hangs.
    const booted = build();
    expect(booted.recoverInterrupted()).toBe(1);
    const after = { job: booted.get(L, submissionId), upload: uploadRow(p.uploadId), sentOnBoot: sent.length };
    // Let the dead process's call return without touching anything the test reads after.
    onSend = undefined;
    release();
    return { ...after, submissionId, booted };
  }

  it('before the send: interrupted, nothing sent on boot', async () => {
    const r = await crashAt('read');
    expect(r.job).toMatchObject({ status: 'interrupted', tournamentItems: [expect.objectContaining({ outcome: 'skipped' })] });
    expect(r.upload).toMatchObject({ state: 'failed', error_code: 'interrupted' });
    expect(r.sentOnBoot).toBe(0);
    expect((await refusal(r.booted.retry(L, r.submissionId, OWNER))).code).toBe('use_upload_again');
  });

  it('after validate went out: validate_unknown, never validated again', async () => {
    const r = await crashAt('validate');
    expect(r.job.tournamentItems[0]!.outcome).toBe('validate_unknown');
    expect(r.upload.state).toBe('validate_unknown');
    expect(r.sentOnBoot).toBe(1);
  });

  it('keeps an outcome the upload already recorded when the crash came just after it', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let arrived!: () => void;
    const arrival = new Promise<void>((r) => (arrived = r));
    const p = await preview();
    onSend = (what) => {
      if (what === 'validate') {
        arrived();
        return held;
      }
    };
    const { submissionId } = await service.uploadResults(L, {
      date: DATE,
      tournamentId: GUID,
      uploadId: p.uploadId,
      body: { importAttendance: false, acknowledgedWarnings: p.fingerprint! },
      actor: OWNER,
    });
    await arrival;
    // The validate answered with errors and the upload recorded it; the process died before the item did.
    database.sqlite
      .prepare("update tournament_result_upload set state = 'not_accepted', upstream_upload_id = 'upload-1' where id = ?")
      .run(p.uploadId);
    const booted = build();
    booted.recoverInterrupted();
    expect(booted.get(L, submissionId).tournamentItems[0]!.outcome).toBe('not_accepted');
    expect(uploadRow(p.uploadId).state).toBe('not_accepted');
    onSend = undefined;
    release();
  });

  it('after confirm went out: processing, settled on read', async () => {
    const r = await crashAt('confirm');
    expect(r.job.tournamentItems[0]!.outcome).toBe('processing');
    expect(r.upload.state).toBe('processing');
  });
});

describe('following processing on History', () => {
  it('shows uploaded once play-tools completes it, and processing_failed on upload_failed', async () => {
    const a = await upload();
    activity.set(GUID, 'completed');
    await service.followResults(L, a.submissionId);
    expect(service.get(L, a.submissionId).tournamentItems[0]!.outcome).toBe('uploaded');

    const b = await upload({ guid: GUID2, content: file({ idElement: '<id>26-10-000124</id>' }) });
    activity.set(GUID2, 'upload_failed');
    await service.followResults(L, b.submissionId);
    expect(service.get(L, b.submissionId).tournamentItems[0]!.outcome).toBe('processing_failed');
  });
});

describe('Remove from staff: a removal-only staff job', () => {
  async function removing(playerIds: string[], beforeJob?: () => void) {
    const p = await preview();
    beforeJob?.();
    const { submissionId } = await service.removeResultsStaff(L, { date: DATE, tournamentId: GUID, uploadId: p.uploadId, playerIds: playerIds as PlayerId[], actor: OWNER });
    await service.idle();
    return { p, submissionId, job: service.get(L, submissionId) };
  }

  it('removes only that player’s staff record, forgets them locally, and re-checks the preview', async () => {
    setPeople(GUID, person('1234567', 'judge'));
    roster.ensurePlayers(L, [{ playerId: '7777777' as PlayerId }]);
    const assign = (playerId: string, state: string, recordId: string | null) =>
      database.sqlite
        .prepare(
          `insert into staff_assignment (league_id, session_date, tournament_id, tournament_label, player_id, role, state, record_id, created_by, created_at)
           values (?, ?, ?, 'Cup', ?, 'judge', ?, ?, 'organizer', 0)`,
        )
        .run(L, DATE, GUID, playerId, state, recordId);
    assign('1234567', 'assigned', 'rec-1234567');
    assign('7777777', 'pending', null);
    database.sqlite
      .prepare(`insert into staff_history (league_id, tournament_id, player_id, role, source, recorded_at) values (?, ?, '1234567', 'judge', 'upstream', 0)`)
      .run(L, GUID);

    const { p, job } = await removing(['1234567']);

    expect(sends('unassign')).toEqual([expect.objectContaining({ args: [GUID, 'rec-1234567', '1234567'] })]);
    expect(job).toMatchObject({ kind: 'staff', status: 'succeeded', items: [expect.objectContaining({ playerId: '1234567', outcome: 'removed' })] });
    expect(database.sqlite.prepare("select count(*) from staff_history where player_id = '1234567'").pluck().get()).toBe(0);
    expect(database.sqlite.prepare('select player_id, state from staff_assignment').all()).toEqual([{ player_id: '7777777', state: 'pending' }]);
    expect(sends('validate')).toEqual([]);
    const after = await results.section(L, DATE, GUID);
    expect(after.latest).toMatchObject({ uploadId: p.uploadId, warnings: [] });
  });

  it('removes nobody already gone', async () => {
    setPeople(GUID, person('1234567', 'judge'));
    const p = await preview();
    setPeople(GUID);
    await expect(results.checkRemovable(L, DATE, GUID, p.uploadId, ['1234567'] as PlayerId[], OWNER)).rejects.toMatchObject({ code: 'not_removable' });
    expect(sends('unassign')).toEqual([]);
  });

  it('settles a player gone by the job’s read as already_removed, sending nothing', async () => {
    setPeople(GUID, person('1234567', 'judge'));
    // Gone after the server's check (its read is the first), before the job's.
    let reads = 0;
    const { job } = await removing(['1234567'], () => {
      onRead = undefined;
      const base = upstream.state.participants;
      const original = base.get.bind(base);
      base.get = (k: string) => (++reads > 1 && k === GUID ? [person(ORGANIZER, 'organizer')] : original(k));
    });
    expect(sends('unassign')).toEqual([]);
    expect(job.items[0]).toMatchObject({ outcome: 'already_removed' });
  });

  it('retries only the players not yet removed, and never the ordinary staff job', async () => {
    setPeople(GUID, person('1234567', 'judge'));
    onSend = (what, n) => {
      if (what === 'unassign' && n === 1) throw new PokemonUpstreamError('refused', 'No.', { status: 400 });
    };
    const first = await removing(['1234567']);
    expect(first.job.items[0]).toMatchObject({ outcome: 'failed' });

    onSend = undefined;
    const { submissionId } = await service.retry(L, first.submissionId, OWNER);
    await service.idle();
    expect(service.get(L, submissionId)).toMatchObject({ kind: 'staff', retryOf: first.submissionId, items: [expect.objectContaining({ playerId: '1234567', outcome: 'removed' })] });
    expect(sends('unassign')).toHaveLength(2);
    expect((await refusal(service.retry(L, submissionId, OWNER))).code).toBe('nothing_to_retry');
  });
});

describe('the send under a lease (ADR-0015 §5)', () => {
  const MISTY = professorActor(2, 'misty');
  const lend = () => {
    upstream.state.leases = [{ id: 7, connectionId: OLIVE.id, tournamentId: GUID, lesseeUserId: MISTY.userId }];
    live = new Set([7]);
  };
  async function uploadAsMisty(beforeJob?: () => void) {
    const p = await results.preview(L, DATE, GUID, { filename: 'cup.tdf', content: file() }, MISTY);
    beforeJob?.();
    const { submissionId } = await service.uploadResults(L, {
      date: DATE,
      tournamentId: GUID,
      uploadId: p.uploadId,
      body: { importAttendance: true, acknowledgedWarnings: p.fingerprint! },
      actor: MISTY,
    });
    await service.idle();
    return service.get(L, submissionId);
  }

  it("sends as the organizer's connection, recording the lent professor and the lease", async () => {
    lend();
    const job = await uploadAsMisty();
    expect(job).toMatchObject({ startedBy: 'misty', leased: true, professor: { playerId: ORGANIZER } });
    expect(sends('validate')).toEqual([expect.objectContaining({ as: OLIVE.id })]);
  });

  it('sends nothing when the lease ends before the validate', async () => {
    lend();
    const job = await uploadAsMisty(() => {
      onRead = () => live.delete(7);
    });
    expect(job.tournamentItems[0]).toMatchObject({ outcome: 'failed', errorCode: 'lease_ended' });
    expect(sends('validate')).toEqual([]);
  });

  it('always finishes the confirm once play-tools validated the file', async () => {
    lend();
    onSend = (what) => {
      if (what === 'validate') live.delete(7);
    };
    const job = await uploadAsMisty();
    expect(sends('confirm')).toHaveLength(1);
    expect(job.tournamentItems[0]).toMatchObject({ outcome: 'processing' });
  });
});
