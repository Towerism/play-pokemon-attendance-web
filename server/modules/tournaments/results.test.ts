import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { silentLogger } from '@towerism/selfhost-kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BIRTHDATE, tomTdf } from '../../../shared/tdf/__fixtures__/tom';
import { warningsFingerprint } from '../../../shared/tdf/fingerprint';
import { TdfError } from '../../../shared/tdf/parse';
import type { PlayerId, SessionDate } from '../../../shared/types/ids';
import { localInstant } from '../../../shared/time/local-time';
import { tdfVault } from '../../bootstrap/vaults';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import { createSightingsService } from '../metrics/sightings';
import { PokemonUpstreamError } from '../pokemon/ports/errors';
import type { ResultsUpload, TournamentParticipant } from '../pokemon/ports/play-tools-gateway';
import { type RosterService, createRosterService } from '../roster/service';
import { type TdfImportService, createTdfImportService, createTdfUploadReferrer } from '../sessions/tdf-import';
import { TdfKeyMismatchError } from '../tdf-archive/errors';
import { type TdfArchiveService, createTdfArchiveService } from '../tdf-archive/service';
import { tournamentResultUpload } from '../../db/schema';
import { TournamentsError } from './errors';
import { type ResultsDeps, type TournamentResults, createResultUploadReferrer, createTournamentResults } from './results';
import { OLIVE, stubPlayTools, upstreamTournament } from './test-helpers';
import { HELD_BY_OWNER, OWNER, professorActor } from '../pokemon/test-connections';

// The tournaments module's side of a TDF results upload (#96, ADR-0011): the preview and its fixes, the full-name
// prompt, recheck / Upload again…, Remove-from-staff's checks, the job's fresh check, following processing, and expiry.
// The job itself is the submission module's (tdf-upload.test.ts). Reads only: nothing here ever sends a file.

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const TZ = 'America/Chicago';
const DATE = '2026-10-14' as SessionDate;
const GUID = 'aaaaaaaa-0000-4000-8000-000000000001';
const DISPLAY_ID = '26-10-000123';
const ORGANIZER = OLIVE.professorPlayerId!;
const START = localInstant(DATE, '18:00', TZ);
const NOW = new Date('2026-10-15T15:00:00Z');
const PLAYERS = [
  { userid: '1234567', first: 'Ash', last: 'Ketchum' },
  { userid: '2345678', first: 'Misty', last: 'Waterflower' },
];
const OWN_ORGANIZER = `<organizer popid="${ORGANIZER}" name="Olive Organizer"/>`;
const WRONG_ORGANIZER = '<organizer popid="1234500" name="Alex Example"/>';
/** A file for this tournament: right id, organizer and game, two players the league knows. */
const file = (o: Parameters<typeof tomTdf>[0] = {}) => tomTdf({ players: PLAYERS, idElement: `<id>${DISPLAY_ID}</id>`, organizerElement: OWN_ORGANIZER, ...o });
const EMPTY = warningsFingerprint([]);

let database: OpenDatabase;
let upstream: ReturnType<typeof stubPlayTools>;
let roster: RosterService;
let archive: TdfArchiveService;
let attendance: TdfImportService;
let results: TournamentResults;
let resultsDeps: ResultsDeps;
let now: Date;
let fullNames: Map<string, string | null>;
let uploadsList: ResultsUpload[];
let activity: string;

const person = (playerId: string, role: string | null, name = `Person ${playerId}`): TournamentParticipant => ({
  recordId: `rec-${playerId}`,
  playerId: playerId as PlayerId,
  role,
  isStaff: role !== null,
  name,
});
const setPeople = (...people: TournamentParticipant[]) => upstream.state.participants.set(GUID, [person(ORGANIZER, 'organizer'), ...people]);

beforeEach(() => {
  database = openDatabase(':memory:');
  migrateDatabase(database.db, MIGRATIONS_DIR);
  now = NOW;
  upstream = stubPlayTools();
  upstream.state.tournaments.push(upstreamTournament('000001', START.toISOString(), { id: GUID, displayId: DISPLAY_ID, editableUntil: new Date(START.getTime() + 90 * 86_400_000) }));
  setPeople();
  activity = 'pending';
  uploadsList = [];
  roster = createRosterService({ db: database.db });
  roster.ensurePlayers(L, PLAYERS.map((p) => ({ playerId: p.userid as PlayerId, name: `${p.first} ${p.last}` })));
  archive = createTdfArchiveService({
    db: database.db,
    vault: tdfVault(randomBytes(32).toString('base64')),
    referrers: () => [createTdfUploadReferrer(database.db), createResultUploadReferrer(database.db)],
    log: silentLogger,
    now: () => now,
  });
  attendance = createTdfImportService({ db: database.db, roster, sightings: createSightingsService({ db: database.db }), archive, now: () => now });
  fullNames = new Map([[ORGANIZER, 'Olive Organizer']]);
  resultsDeps = {
    db: database.db,
    connections: upstream.connections,
    gateway: (as) => {
      const g = upstream.gateway(as);
      return {
        ...g,
        getTournament: async (id: string) => ({ ...(await g.getTournament(id)), activityState: activity, organizerName: 'Olive Q Organizer' }),
        listResultsUploads: async () => uploadsList,
      };
    },
    names: {
      fullNameOf: (_league, playerId) => fullNames.get(playerId) ?? null,
      saveFullName: (_league, playerId, fullName) => void fullNames.set(playerId, fullName),
    },
    archive,
    attendance,
    roster,
    timeZone: TZ,
    now: () => now,
  };
  results = createTournamentResults(resultsDeps);
});
afterEach(() => database.close());
const deps = () => resultsDeps;

const preview = (content: string, filename = 'cup.tdf') => results.preview(L, DATE, GUID, { filename, content }, OWNER);
const archived = (fileId: number) => archive.read(L, fileId).content;
type UploadRow = { id: number; state: string; tdf_file_id: number | null; sha256: string; warnings_fingerprint: string | null; attendance_upload_id: number | null };
const uploadRow = (id: number) => database.sqlite.prepare('select * from tournament_result_upload where id = ?').get(id) as UploadRow;
const count = (table: string) => (database.sqlite.prepare(`select count(*) n from ${table}`).get() as { n: number }).n;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const reads = () => upstream.state.calls.filter((c) => !c.startsWith('getTournament') && !c.startsWith('listTournamentParticipants'));
const refusal = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(TournamentsError);
  return err as TournamentsError;
};

describe('preview', () => {
  it('stores the file once for both uses and answers a clean preview, reading only', async () => {
    const p = await preview(file());

    expect(p).toMatchObject({
      state: 'previewed',
      tournament: { id: GUID, displayId: DISPLAY_ID, date: DATE },
      file: { filename: 'cup.tdf', playerCount: 2 },
      needsOrganizerFullName: null,
      warnings: [],
      fingerprint: EMPTY,
      attendance: { counts: expect.objectContaining({ known: 2 }) },
    });
    expect(count('tdf_file')).toBe(1);
    const row = uploadRow(p.uploadId);
    expect(row).toMatchObject({ state: 'previewed', sha256: sha(file()), attendance_upload_id: p.attendance!.uploadId });
    expect(archived(row.tdf_file_id!)).toBe(file());
    expect(reads()).toEqual([]);
  });

  it.each([
    ['too_large', 'x'.repeat(2 * 1024 * 1024 + 1)],
    ['unsafe', '<!DOCTYPE x><tournament/>'],
    ['not_tdf', 'not xml at all <'],
  ])('refuses a file that is %s, storing nothing', async (code, content) => {
    await expect(preview(content)).rejects.toMatchObject({ code });
    await expect(preview(content)).rejects.toBeInstanceOf(TdfError);
    expect(count('tdf_file') + count('tournament_result_upload') + count('tdf_upload')).toBe(0);
  });

  it('is not found for another date, another league or a guid nobody can read', async () => {
    expect((await refusal(results.preview(L, '2026-10-15' as SessionDate, GUID, { filename: 'a.tdf', content: file() }, OWNER))).code).toBe('not_found');
    upstream.state.tournaments[0] = { ...upstream.state.tournaments[0]!, groupId: 'other-group' };
    expect((await refusal(preview(file()))).code).toBe('not_found');
    expect((await refusal(results.preview(L, DATE, 'bbbbbbbb-0000-4000-8000-000000000001', { filename: 'a.tdf', content: file() }, OWNER))).code).toBe('not_found');
    expect(count('tdf_file')).toBe(0);
  });

  it('blocks a tournament whose organizer is not connected, or must reconnect, saying which', async () => {
    upstream.state.tournaments[0] = { ...upstream.state.tournaments[0]!, organizer: '5555555' };
    upstream.state.professors.push({ id: 7, professorPlayerId: '5555555', professorName: 'Nurse Joy', status: 'connected', ...HELD_BY_OWNER });
    upstream.state.professors[1] = { ...upstream.state.professors[1]!, status: 'needs_reconnect' };
    // Olive reads it, but Joy organizes it and must reconnect.
    expect(await refusal(preview(file()))).toMatchObject({ code: 'results_not_accepted', details: { reason: 'needs_reconnect' } });
    upstream.state.professors.pop();
    expect(await refusal(preview(file()))).toMatchObject({ code: 'results_not_accepted', details: { reason: 'organizer_not_connected' } });
    expect(count('tdf_file')).toBe(0);
  });

  it.each([
    ['approval-pending', { applicationState: 'approval-pending' }, [], 'results_not_accepted'],
    ['complete', { status: 'complete' }, [], 'results_already_uploaded'],
    ['a player record', {}, [person('8000', null)], 'results_already_uploaded'],
  ])('blocks a tournament that is %s, storing nothing', async (_label, patch, people, code) => {
    upstream.state.tournaments[0] = { ...upstream.state.tournaments[0]!, ...patch };
    setPeople(...(people as TournamentParticipant[]));
    expect((await refusal(preview(file()))).code).toBe(code);
    expect(count('tdf_file')).toBe(0);
  });

  it('blocks results already processing, and takes one after a failed processing', async () => {
    activity = 'upload_in_progress';
    expect((await refusal(preview(file()))).code).toBe('results_already_uploaded');
    activity = 'upload_failed';
    expect((await preview(file())).state).toBe('previewed');
  });

  it('fills an empty id, keeping only the corrected file, and warns', async () => {
    const original = file({ idElement: '<id/>' });
    const p = await preview(original);

    const row = uploadRow(p.uploadId);
    expect(archived(row.tdf_file_id!)).toBe(original.replace('<id/>', `<id>${DISPLAY_ID}</id>`));
    expect(row.sha256).toBe(sha(original));
    expect(count('tdf_file')).toBe(1);
    expect(p.warnings).toEqual([expect.objectContaining({ code: 'tdf_tournament_id_filled', displayId: DISPLAY_ID })]);
  });

  it('never changes an id that is present', async () => {
    const original = file({ idElement: '<id>26-10-000999</id>' });
    const p = await preview(original);
    expect(archived(uploadRow(p.uploadId).tdf_file_id!)).toBe(original);
    expect(p.warnings.map((w) => w.code)).toEqual(['tdf_wrong_tournament']);
  });

  it('replaces a wrong organizer with the saved full name, re-pointing the attendance import', async () => {
    const original = file({ organizerElement: WRONG_ORGANIZER });
    fullNames.set(ORGANIZER, "Olive O'Organizer");
    const earlier = attendance.preview(L, DATE, { filename: 'cup.tdf', content: original, by: 'organizer' });

    const p = await preview(original);

    const row = uploadRow(p.uploadId);
    const corrected = archived(row.tdf_file_id!);
    expect(corrected).toBe(original.replace(WRONG_ORGANIZER, `<organizer popid="${ORGANIZER}" name="Olive O&apos;Organizer"/>`));
    expect(count('tdf_file')).toBe(1);
    expect(row.sha256).toBe(sha(original));
    const attendanceFile = database.sqlite.prepare('select tdf_file_id from tdf_upload where id = ?').pluck().get(earlier.uploadId);
    expect(attendanceFile).toBe(row.tdf_file_id);
    expect(p.warnings).toEqual([
      expect.objectContaining({ code: 'tdf_organizer_replaced', from: { playerId: '1234500', name: 'Alex Example' }, to: { playerId: ORGANIZER, name: "Olive O'Organizer" } }),
    ]);
  });

  it('asks for the full name once, then corrects the file and saves the name', async () => {
    fullNames.clear();
    const original = file({ organizerElement: WRONG_ORGANIZER });

    const p = await preview(original);
    expect(p).toMatchObject({ needsOrganizerFullName: { playerId: ORGANIZER, playToolsName: 'Olive Q Organizer' }, warnings: [], fingerprint: null });
    expect(archived(uploadRow(p.uploadId).tdf_file_id!)).toBe(original);
    expect((await refusal(Promise.resolve().then(() => results.prepareConfirm(L, DATE, GUID, p.uploadId, { importAttendance: true, acknowledgedWarnings: EMPTY }, OWNER)))).code).toBe(
      'organizer_full_name_required',
    );

    const named = await results.setOrganizerName(L, DATE, GUID, p.uploadId, 'Olive Organizer', OWNER);
    expect(fullNames.get(ORGANIZER)).toBe('Olive Organizer');
    expect(named).toMatchObject({ uploadId: p.uploadId, needsOrganizerFullName: null, warnings: [expect.objectContaining({ code: 'tdf_organizer_replaced' })] });
    expect(archived(uploadRow(p.uploadId).tdf_file_id!)).toContain(`popid="${ORGANIZER}" name="Olive Organizer"`);
    expect(count('tdf_file')).toBe(1);

    expect((await refusal(results.setOrganizerName(L, DATE, GUID, p.uploadId, 'Olive', OWNER))).code).toBe('organizer_name_not_needed');
  });

  it('flags staff who played (the organizer unremovable) and players new to the app with a name hint', async () => {
    roster.ensurePlayers(L, [{ playerId: '0042' as PlayerId, name: 'Brock Harrison' }]);
    setPeople(person('1234567', 'judge'));
    const p = await preview(
      file({ players: [...PLAYERS, { userid: ORGANIZER, first: 'Olive', last: 'Organizer' }, { userid: '999', first: 'brock', last: ' HARRISON' }] }),
    );
    expect(p.warnings).toEqual([
      expect.objectContaining({ code: 'tdf_staff_also_playing', player: expect.objectContaining({ playerId: '1234567', role: 'judge', removable: true }) }),
      expect.objectContaining({ code: 'tdf_staff_also_playing', player: expect.objectContaining({ playerId: ORGANIZER, role: 'organizer', removable: false }) }),
      expect.objectContaining({
        code: 'tdf_unknown_players',
        players: [
          { playerId: ORGANIZER, name: 'Olive Organizer', knownAs: null },
          { playerId: '999', name: 'brock HARRISON', knownAs: '0042' },
        ],
      }),
    ]);
    expect(p.fingerprint).not.toBe(EMPTY);
    expect(roster.getPlayers(L, ['999' as PlayerId])).toEqual([]);
  });

  it('warns of a file for another game', async () => {
    expect((await preview(file({ gametype: 'VIDEO_GAME' }))).warnings.map((w) => w.code)).toEqual(['tdf_wrong_game']);
  });

  it('reuses the open preview of the same file for the same tournament', async () => {
    const a = await preview(file());
    const b = await preview(file());
    expect(b.uploadId).toBe(a.uploadId);
    expect(count('tournament_result_upload')).toBe(1);
  });

  it('never puts a birthdate in a row', async () => {
    await preview(file());
    const rows = JSON.stringify(database.sqlite.prepare('select * from tournament_result_upload').all());
    expect(rows).not.toContain(BIRTHDATE);
  });
});

describe('recheck (Upload again…)', () => {
  it('updates an open preview in place from a fresh read', async () => {
    const p = await preview(file());
    setPeople(person('1234567', 'judge'));
    const again = await results.recheck(L, DATE, GUID, p.uploadId, OWNER);
    expect(again.uploadId).toBe(p.uploadId);
    expect(again.warnings.map((w) => w.code)).toEqual(['tdf_staff_also_playing']);
    expect(uploadRow(p.uploadId).warnings_fingerprint).toBe(again.fingerprint);
  });

  it('keeps a corrected file’s corrections, so the fingerprint holds (ADR-0011 Update #96)', async () => {
    const p = await preview(file({ organizerElement: WRONG_ORGANIZER, idElement: '<id/>' }));
    const again = await results.recheck(L, DATE, GUID, p.uploadId, OWNER);
    expect(again.fingerprint).toBe(p.fingerprint);
    expect(again.warnings.map((w) => w.code)).toEqual(['tdf_organizer_replaced', 'tdf_tournament_id_filled']);
  });

  it('opens a new attempt for a finished upload, once, from the archived file', async () => {
    const p = await preview(file());
    database.sqlite.prepare("update tournament_result_upload set state = 'not_accepted' where id = ?").run(p.uploadId);
    const again = await results.recheck(L, DATE, GUID, p.uploadId, OWNER);
    expect(again.uploadId).not.toBe(p.uploadId);
    expect(uploadRow(again.uploadId)).toMatchObject({ state: 'previewed', tdf_file_id: uploadRow(p.uploadId).tdf_file_id, sha256: uploadRow(p.uploadId).sha256 });
    expect((await results.recheck(L, DATE, GUID, p.uploadId, OWNER)).uploadId).toBe(again.uploadId);
  });

  it('asks for the file again once it was deleted', async () => {
    const p = await preview(file());
    archive.delete(L, uploadRow(p.uploadId).tdf_file_id!);
    expect((await refusal(results.recheck(L, DATE, GUID, p.uploadId, OWNER))).code).toBe('tdf_file_deleted');
  });

  it('is not found for an upload of another tournament or date', async () => {
    const p = await preview(file());
    expect((await refusal(results.recheck(L, '2026-10-21' as SessionDate, GUID, p.uploadId, OWNER))).code).toBe('not_found');
    expect((await refusal(results.recheck(L, DATE, 'bbbbbbbb-0000-4000-8000-000000000001', p.uploadId, OWNER))).code).toBe('not_found');
  });
});

describe('Remove from staff: checked before any job', () => {
  it('refuses ids not in the file, not on staff, or the organizer, naming each', async () => {
    setPeople(person('1234567', 'judge'));
    const p = await preview(file({ players: [...PLAYERS, { userid: ORGANIZER, first: 'Olive' }] }));
    const err = await refusal(results.checkRemovable(L, DATE, GUID, p.uploadId, ['5555', '2345678', ORGANIZER, '1234567'] as PlayerId[], OWNER));
    expect(err).toMatchObject({
      code: 'not_removable',
      details: {
        failures: [
          { playerId: '5555', reason: 'not_in_file' },
          { playerId: '2345678', reason: 'not_staff' },
          { playerId: ORGANIZER, reason: 'organizer' },
        ],
      },
    });
  });

  it('answers the organizer to act as for staff who played', async () => {
    setPeople(person('1234567', 'scorekeeper'));
    const p = await preview(file());
    expect(await results.checkRemovable(L, DATE, GUID, p.uploadId, ['1234567'] as PlayerId[], OWNER)).toMatchObject({
      tournamentId: GUID,
      professorPlayerId: ORGANIZER,
      uploadId: p.uploadId,
    });
  });
});

describe('confirm: what the server checks', () => {
  it('refuses a fingerprint that is not the preview’s, with the current warnings', async () => {
    setPeople(person('1234567', 'judge'));
    const p = await preview(file());
    const err = await refusal(Promise.resolve().then(() => results.prepareConfirm(L, DATE, GUID, p.uploadId, { importAttendance: true, acknowledgedWarnings: EMPTY }, OWNER)));
    expect(err).toMatchObject({ code: 'warnings_not_acknowledged', details: { fingerprint: p.fingerprint, warnings: p.warnings } });
  });

  it('takes the preview’s fingerprint, and only once', async () => {
    const p = await preview(file());
    const plan = results.prepareConfirm(L, DATE, GUID, p.uploadId, { importAttendance: true, acknowledgedWarnings: EMPTY }, OWNER);
    expect(plan).toMatchObject({ uploadId: p.uploadId, professorPlayerId: ORGANIZER, label: expect.stringContaining(DATE) });
    expect(results.markSending(p.uploadId, { by: 'organizer', fingerprint: EMPTY, submissionId: 9 })).toBe(true);
    expect(results.markSending(p.uploadId, { by: 'organizer', fingerprint: EMPTY, submissionId: 10 })).toBe(false);
    expect(await refusal(Promise.resolve().then(() => results.prepareConfirm(L, DATE, GUID, p.uploadId, { importAttendance: true, acknowledgedWarnings: EMPTY }, OWNER)))).toMatchObject({
      code: 'upload_not_open',
      details: { state: 'sending' },
    });
  });
});

describe('the job’s fresh check (jobCheck)', () => {
  async function sending(content = file()) {
    const p = await preview(content);
    results.markSending(p.uploadId, { by: 'organizer', fingerprint: p.fingerprint!, submissionId: 9 });
    return p;
  }

  it('sends the archived file to the card’s tournament as its organizer', async () => {
    const p = await sending();
    expect(await results.jobCheck(L, p.uploadId)).toMatchObject({ kind: 'send', displayId: DISPLAY_ID, tournamentId: GUID, content: file(), connectionId: OLIVE.id });
  });

  it('keeps a corrected upload sendable (ADR-0011 Update #96)', async () => {
    const p = await sending(file({ organizerElement: WRONG_ORGANIZER, idElement: '<id/>' }));
    expect((await results.jobCheck(L, p.uploadId)).kind).toBe('send');
  });

  it('stops on changed warnings, storing them', async () => {
    const p = await sending();
    setPeople(person('2345678', 'judge'));
    const check = await results.jobCheck(L, p.uploadId);
    expect(check).toMatchObject({ kind: 'warnings_changed', warnings: [expect.objectContaining({ code: 'tdf_staff_also_playing' })] });
    expect(uploadRow(p.uploadId).warnings_fingerprint).not.toBe(EMPTY);
  });

  it('stops when the tournament can no longer take an upload, or is gone', async () => {
    const p = await sending();
    setPeople(person('8000', null));
    expect(await results.jobCheck(L, p.uploadId)).toMatchObject({ kind: 'blocked', code: 'results_already_uploaded' });
    upstream.state.tournaments.length = 0;
    expect(await results.jobCheck(L, p.uploadId)).toMatchObject({ kind: 'blocked', code: 'unknown_tournament' });
  });

  it('fails on a deleted file, nothing to send', async () => {
    const p = await sending();
    archive.delete(L, uploadRow(p.uploadId).tdf_file_id!);
    expect(await results.jobCheck(L, p.uploadId)).toMatchObject({ kind: 'blocked', code: 'tdf_file_deleted' });
  });

  it('throws the connection’s error when the organizer must reconnect', async () => {
    const p = await sending();
    upstream.state.professors[0] = { ...upstream.state.professors[0]!, status: 'needs_reconnect' };
    await expect(results.jobCheck(L, p.uploadId)).rejects.toMatchObject({ code: 'needs_reconnect' });
    await expect(results.jobCheck(L, p.uploadId)).rejects.toBeInstanceOf(PokemonUpstreamError);
  });
});

describe('following processing (ADR-0011 Update #96)', () => {
  async function processing() {
    const p = await preview(file());
    results.markSending(p.uploadId, { by: 'organizer', fingerprint: EMPTY, submissionId: 9 });
    results.record(p.uploadId, { state: 'processing', upstreamUploadId: 'upload-1' });
    return p.uploadId;
  }

  it('moves to complete once play-tools reports it, and to failed on upload_failed', async () => {
    const id = await processing();
    activity = 'upload_in_progress';
    expect(await results.follow(L, id)).toBe('processing');
    activity = 'completed';
    expect(await results.follow(L, id)).toBe('complete');
    expect(await results.follow(L, id)).toBe('complete');
  });

  it('fails processing on upload_failed', async () => {
    const id = await processing();
    activity = 'upload_failed';
    expect(await results.follow(L, id)).toBe('failed');
    expect(database.sqlite.prepare('select error_code from tournament_result_upload where id = ?').pluck().get(id)).toBe('processing_failed');
  });

  it('settles a confirm that may not have landed from the uploads list', async () => {
    const id = await processing();
    uploadsList = [{ uploadId: 'upload-1', accepted: true, errors: [], uploadedAt: NOW }];
    expect(await results.follow(L, id)).toBe('processing');
    uploadsList = [{ uploadId: 'upload-1', accepted: false, errors: [], uploadedAt: NOW }];
    expect(await results.follow(L, id)).toBe('failed');
    expect(database.sqlite.prepare('select error_code from tournament_result_upload where id = ?').pluck().get(id)).toBe('confirm_not_landed');
  });

  it('fails a confirm play-tools does not list at all', async () => {
    const id = await processing();
    expect(await results.follow(L, id)).toBe('failed');
  });

  it('leaves the upload as it is when play-tools cannot be read', async () => {
    const id = await processing();
    upstream.state.failNext.set('getTournament', new PokemonUpstreamError('unavailable', 'down'));
    expect(await results.follow(L, id)).toBe('processing');
  });

  it('shows the Results section with the latest upload and play-tools’ status', async () => {
    const id = await processing();
    activity = 'completed';
    const section = await results.section(L, DATE, GUID);
    expect(section).toMatchObject({ upstream: { status: 'complete' }, latest: { uploadId: id, state: 'complete', acknowledged: { by: 'organizer', fingerprint: EMPTY } } });
  });

  it('shows awaiting results, and why an upload is not possible', async () => {
    expect(await results.section(L, DATE, GUID)).toMatchObject({ upstream: { status: 'awaiting_results', reason: null }, latest: null, earlier: [] });
    upstream.state.tournaments[0] = { ...upstream.state.tournaments[0]!, applicationState: 'approval-pending' };
    expect(await results.section(L, DATE, GUID)).toMatchObject({ upstream: { status: 'results_not_accepted', reason: 'not_sanctioned' } });
  });
});

describe('expiry and the archive', () => {
  it('drops previews older than a day and their files; keeps a confirmed upload and its file', async () => {
    const old = await preview(file());
    now = new Date(NOW.getTime() + 1000);
    const kept = await preview(file({ players: [PLAYERS[0]!] }));
    results.markSending(kept.uploadId, { by: 'organizer', fingerprint: kept.fingerprint!, submissionId: 9 });
    results.record(kept.uploadId, { state: 'processing' });

    now = new Date(NOW.getTime() + 25 * 3_600_000);
    expect(results.expirePreviews()).toBe(1);
    attendance.expirePreviews();

    expect(database.sqlite.prepare('select id from tournament_result_upload').pluck().all()).toEqual([kept.uploadId]);
    expect(database.sqlite.prepare('select id from tdf_file').pluck().all()).toEqual([uploadRow(kept.uploadId).tdf_file_id]);
    void old;
  });

  it('reports a results upload when its file is deleted', async () => {
    const p = await preview(file());
    expect(archive.delete(L, uploadRow(p.uploadId).tdf_file_id!).referencedBy).toEqual(
      expect.arrayContaining([
        { kind: 'results', id: p.uploadId },
        { kind: 'attendance', id: p.attendance!.uploadId },
      ]),
    );
    expect(uploadRow(p.uploadId).tdf_file_id).toBeNull();
  });
});

describe('Download TDF: the archived file of the latest confirmed upload', () => {
  type State = (typeof tournamentResultUpload.$inferSelect)['state'];
  let seq = 0;
  /** One results attempt for the tournament, with its own distinct file stored in the archive. */
  const attempt = (state: State, o: { tournamentId?: string; leagueId?: string } = {}) => {
    const leagueId = o.leagueId ?? L;
    const filename = `attempt-${++seq}.tdf`;
    const content = file({ players: [{ userid: String(3000000 + seq), first: 'Player', last: `No${seq}` }] });
    const { fileId } = archive.store(leagueId, { filename, content, by: 'organizer' });
    const { id } = database.db
      .insert(tournamentResultUpload)
      .values({ leagueId, tournamentId: o.tournamentId ?? GUID, sessionDate: DATE, filename, tdfFileId: fileId, sha256: sha(content), playerCount: 1, state, createdAt: now })
      .returning({ id: tournamentResultUpload.id })
      .get();
    return { uploadId: id, fileId, filename, content };
  };
  beforeEach(() => (seq = 0));

  it('serves the confirmed upload’s file, and no_tdf when there is no upload', () => {
    expect(() => results.download(L, GUID)).toThrow(expect.objectContaining({ code: 'no_tdf' }));

    const done = attempt('complete');
    expect(results.download(L, GUID)).toEqual({ fileId: done.fileId, filename: done.filename, content: done.content });
  });

  const UNCONFIRMED: State[] = ['previewed', 'sending', 'not_accepted', 'warnings_changed', 'validate_unknown', 'failed'];

  it.each(UNCONFIRMED)('never serves a newer %s attempt over the confirmed one', (state) => {
    const done = attempt('complete');
    attempt(state);
    expect(results.download(L, GUID).fileId).toBe(done.fileId);
  });

  it('serves an upload play-tools is still processing: it is the file the app sent', () => {
    attempt('complete');
    const latest = attempt('processing');
    expect(results.download(L, GUID).fileId).toBe(latest.fileId);
  });

  it('is no_tdf when no attempt was confirmed, even though their files are archived', () => {
    for (const state of UNCONFIRMED) attempt(state);
    expect(() => results.download(L, GUID)).toThrow(expect.objectContaining({ code: 'no_tdf' }));
  });

  it('falls back to the next-latest confirmed upload whose file still exists, then no_tdf once none has one', () => {
    const a = attempt('complete');
    const b = attempt('complete');

    archive.delete(L, b.fileId);
    expect(results.download(L, GUID)).toEqual({ fileId: a.fileId, filename: a.filename, content: a.content });

    archive.delete(L, a.fileId);
    expect(() => results.download(L, GUID)).toThrow(expect.objectContaining({ code: 'no_tdf' }));
  });

  it('never serves another league’s upload of the same tournament', () => {
    database.sqlite.prepare("insert into league (id, name) values ('other', 'Other league')").run();
    attempt('complete', { leagueId: 'other' });
    expect(() => results.download(L, GUID)).toThrow(expect.objectContaining({ code: 'no_tdf' }));
  });

  it('refuses a latest file this install’s key can’t open, never falling back to an older one', () => {
    attempt('complete');
    const latest = attempt('complete');
    // The latest ciphertext sealed under another key, as after a restore without secrets/.
    const foreign = createTdfArchiveService({ db: database.db, vault: tdfVault(randomBytes(32).toString('base64')), referrers: () => [], log: silentLogger });
    const resealed = foreign.store(L, { filename: 'x.tdf', content: `${latest.content}\n`, by: 'organizer' });
    database.sqlite.prepare('update tournament_result_upload set tdf_file_id = ? where id = ?').run(resealed.fileId, latest.uploadId);

    expect(() => results.download(L, GUID)).toThrow(TdfKeyMismatchError);
  });

  it('is no_tdf, not a crash, when the file is deleted between the lookup and the read', () => {
    attempt('complete');
    const racing = createTournamentResults({
      ...deps(),
      archive: {
        ...archive,
        read: (leagueId, fileId) => {
          archive.delete(leagueId, fileId);
          return archive.read(leagueId, fileId);
        },
      },
    });
    expect(() => racing.download(L, GUID)).toThrow(expect.objectContaining({ code: 'no_tdf' }));
  });

  it('marks tdfAvailable exactly the tournaments a download would serve, from local rows only', () => {
    const served = 'aaaaaaaa-0000-4000-8000-00000000000a';
    const deleted = 'aaaaaaaa-0000-4000-8000-00000000000b';
    const failedOnly = 'aaaaaaaa-0000-4000-8000-00000000000c';
    const none = 'aaaaaaaa-0000-4000-8000-00000000000d';
    attempt('complete', { tournamentId: served });
    archive.delete(L, attempt('complete', { tournamentId: deleted }).fileId);
    attempt('failed', { tournamentId: failedOnly });
    const before = upstream.state.calls.length;

    expect(results.tdfAvailable(L, [served, deleted, failedOnly, none])).toEqual(new Set([served]));
    expect(results.tdfAvailable(L, [])).toEqual(new Set());
    expect(upstream.state.calls.length).toBe(before);
  });

  it('tells the card’s Results section whether the app holds the TDF', async () => {
    const done = attempt('complete');
    expect((await results.section(L, DATE, GUID)).tdfAvailable).toBe(true);

    archive.delete(L, done.fileId);
    expect((await results.section(L, DATE, GUID)).tdfAvailable).toBe(false);
  });
});

describe('who may upload results (ADR-0015 §4)', () => {
  const MISTY = professorActor(2, 'misty');

  it("refuses a professor's drop for the owner's tournament, storing nothing", async () => {
    const err = await refusal(results.preview(L, DATE, GUID, { filename: 'cup.tdf', content: file() }, MISTY));
    expect(err).toMatchObject({ code: 'not_your_connection', details: { professorPlayerId: OLIVE.professorPlayerId } });
    expect(count('tournament_result_upload')).toBe(0);
  });

  it("refuses a professor's confirm of the owner's upload", async () => {
    const p = await preview(file());
    const err = await refusal(Promise.resolve().then(() => results.prepareConfirm(L, DATE, GUID, p.uploadId, { importAttendance: true, acknowledgedWarnings: EMPTY }, MISTY)));
    expect(err.code).toBe('not_your_connection');
  });
});

describe('results under a lease (ADR-0015 §5)', () => {
  const MISTY = professorActor(2, 'misty');
  const lent = () => (upstream.state.leases = [{ id: 7, connectionId: OLIVE.id, tournamentId: GUID, lesseeUserId: MISTY.userId }]);

  it("lets the lent professor preview, recheck and send the tournament's results as its organizer, naming the lease", async () => {
    lent();
    const p = await results.preview(L, DATE, GUID, { filename: 'cup.tdf', content: file() }, MISTY);
    await results.recheck(L, DATE, GUID, p.uploadId, MISTY);
    expect(results.prepareConfirm(L, DATE, GUID, p.uploadId, { importAttendance: true, acknowledgedWarnings: p.fingerprint ?? EMPTY }, MISTY)).toMatchObject({
      professorPlayerId: ORGANIZER,
      leaseId: 7,
    });
  });

  it('lets the lent professor remove staff who played, under the lease', async () => {
    lent();
    setPeople(person('1234567', 'scorekeeper'));
    const p = await results.preview(L, DATE, GUID, { filename: 'cup.tdf', content: file() }, MISTY);
    expect(await results.checkRemovable(L, DATE, GUID, p.uploadId, ['1234567'] as PlayerId[], MISTY)).toMatchObject({ professorPlayerId: ORGANIZER, leaseId: 7 });
  });

  it("never lets the lent professor set the organizer's full name", async () => {
    lent();
    fullNames.clear();
    const p = await results.preview(L, DATE, GUID, { filename: 'cup.tdf', content: file({ organizerElement: WRONG_ORGANIZER }) }, MISTY);
    expect((await refusal(results.setOrganizerName(L, DATE, GUID, p.uploadId, 'Olive Organizer', MISTY))).code).toBe('not_your_connection');
    expect(fullNames.get(ORGANIZER)).toBeUndefined();
  });

  it("names no lease for the organizer's own send", async () => {
    lent();
    const p = await preview(file());
    expect(results.prepareConfirm(L, DATE, GUID, p.uploadId, { importAttendance: true, acknowledgedWarnings: p.fingerprint ?? EMPTY }, OWNER)).toMatchObject({ leaseId: null });
  });
});

describe("the stored files of the tournaments a professor organizes (ADR-0015 §4)", () => {
  it('lists the files of results uploads whose organizer is one of the given professors', async () => {
    const p = await preview(file());
    const fileId = uploadRow(p.uploadId).tdf_file_id!;
    expect(results.fileIdsOrganizedBy(L, [OLIVE.professorPlayerId!])).toEqual(new Set([fileId]));
    expect(results.fileIdsOrganizedBy(L, ['0000222'])).toEqual(new Set());
    expect(results.fileIdsOrganizedBy(L, [])).toEqual(new Set());
  });
});

