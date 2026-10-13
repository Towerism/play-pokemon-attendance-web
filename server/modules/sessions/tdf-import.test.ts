import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tomTdf } from '../../../shared/tdf/__fixtures__/tom';
import { TdfError } from '../../../shared/tdf/parse';
import type { PlayerId, SessionDate } from '../../../shared/types/ids';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import { type SightingsService, createSightingsService } from '../metrics/sightings';
import { silentLogger } from '../../logging/types';
import { type RosterService, createRosterService } from '../roster/service';
import { TdfKeyMismatchError } from '../tdf-archive/errors';
import { type TdfArchiveService, createTdfArchiveService } from '../tdf-archive/service';
import { createVault } from '../vault/vault';
import { type SessionsService, createSessionsService } from './service';
import {
  TdfFileDeletedError,
  type TdfImportService,
  UploadNotFoundError,
  createTdfImportService,
  createTdfUploadReferrer,
} from './tdf-import';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const OTHER = 'other-league';
const id = (s: string) => s as PlayerId;
const WED = '2026-10-14' as SessionDate;
const NEXT_WED = '2026-10-21' as SessionDate;

function tdf(players: { userid: string; name?: string }[], tournament = 'Wed League Cup'): string {
  const rows = players
    .map(({ userid, name = '' }) => {
      const [first = '', last = ''] = name.split(' ');
      return `<player userid="${userid}"><firstname>${first}</firstname><lastname>${last}</lastname><birthdate>01/02/2012</birthdate></player>`;
    })
    .join('');
  return `<?xml version="1.0"?><tournament><data><name>${tournament}</name><startdate>10/14/2026</startdate></data><players>${rows}</players></tournament>`;
}

let database: OpenDatabase;
let roster: RosterService;
let sightings: SightingsService;
let sessions: SessionsService;
let archive: TdfArchiveService;
let imports: TdfImportService;
let now: Date;

function archiveWith(key: string): TdfArchiveService {
  return createTdfArchiveService({
    db: database.db,
    vault: createVault(key, 'tdf'),
    referrers: () => [createTdfUploadReferrer(database.db)],
    log: silentLogger,
    now: () => now,
  });
}

beforeEach(() => {
  database = openDatabase(':memory:');
  migrateDatabase(database.db, MIGRATIONS_DIR);
  database.sqlite.prepare("insert into league (id, name) values (?, 'Other')").run(OTHER);
  roster = createRosterService({ db: database.db });
  sightings = createSightingsService({ db: database.db });
  sessions = createSessionsService({ db: database.db, roster, sightings });
  now = new Date('2026-10-14T23:00:00Z');
  archive = archiveWith(randomBytes(32).toString('base64'));
  imports = createTdfImportService({ db: database.db, roster, sightings, archive, now: () => now });
});
afterEach(() => database.close());

/** A preview as the organizer drops it. */
const previewFile = (league: string, date: SessionDate, file: { filename: string; content: string }) =>
  imports.preview(league, date, { ...file, by: 'organizer' });
const uploadRows = () =>
  database.sqlite.prepare('select id, sha256, tdf_file_id as fileId, status from tdf_upload order by id').all() as {
    id: number;
    sha256: string;
    fileId: number | null;
    status: string;
  }[];
const dangling = () =>
  database.sqlite
    .prepare('select count(*) from tdf_upload where tdf_file_id is not null and tdf_file_id not in (select id from tdf_file)')
    .pluck()
    .get();
const count = (table: string) => (database.sqlite.prepare(`select count(*) n from ${table}`).get() as { n: number }).n;

describe('preview', () => {
  it('classifies each player against the league: new, known, regular, or already listed for the date', () => {
    roster.ensurePlayers(L, [{ playerId: id('2'), name: 'Known Kim' }]);
    roster.addRegular(L, { playerId: id('3'), name: 'Regular Rae' });
    sessions.addPlayer(L, WED, { playerId: id('4'), name: 'Listed Lee' });

    const preview = previewFile(L, WED, {
      filename: 'cup.tdf',
      content: tdf([
        { userid: '1', name: 'New Nia' },
        { userid: '2', name: 'Other Name' },
        { userid: '3', name: 'Regular Rae' },
        { userid: '4', name: 'Listed Lee' },
      ]),
    });

    expect(preview).toEqual({
      uploadId: expect.any(Number),
      filename: 'cup.tdf',
      tournament: { name: 'Wed League Cup', date: '2026-10-14' },
      alreadyImported: false,
      counts: { new: 1, known: 1, regulars: 1, listed: 1, invalid: 0, duplicates: 0 },
      players: [
        { playerId: '1', name: 'New Nia', status: 'new' },
        // A known player keeps the name on file; the file never renames anyone.
        { playerId: '2', name: 'Known Kim', status: 'known' },
        { playerId: '3', name: 'Regular Rae', status: 'regular' },
        { playerId: '4', name: 'Listed Lee', status: 'listed' },
      ],
      invalid: [],
    });
  });

  it('reports invalid rows and duplicates from the file', () => {
    const preview = previewFile(L, WED, {
      filename: 'cup.tdf',
      content: tdf([{ userid: '1' }, { userid: 'nope', name: 'Bad Row' }, { userid: '1' }]),
    });

    expect(preview.counts).toMatchObject({ new: 1, invalid: 1, duplicates: 1 });
    expect(preview.invalid).toEqual([{ name: 'Bad Row', reason: expect.any(String) }]);
  });

  it('changes nothing in the roster, session or sightings', () => {
    previewFile(L, WED, { filename: 'cup.tdf', content: tdf([{ userid: '1', name: 'New Nia' }]) });

    expect(roster.listPlayers(L)).toEqual([]);
    expect(sessions.getSession(L, WED).players).toEqual([]);
    expect(sightings.on(L, WED)).toEqual([]);
  });

  it('keeps the file only in the encrypted archive, not yet kept, with the upload pointing at it', () => {
    previewFile(L, WED, { filename: 'cup.tdf', content: tdf([{ userid: '1', name: 'New Nia' }]) });

    const [file] = archive.list(L);
    expect(file).toMatchObject({ filename: 'cup.tdf', keptFor: [] });
    expect(uploadRows()).toEqual([{ id: expect.any(Number), sha256: expect.any(String), fileId: file!.id, status: 'pending' }]);
    const dump =
      JSON.stringify(database.sqlite.prepare('select * from tdf_upload').all()) +
      (database.sqlite.prepare('select ciphertext from tdf_file').pluck().get() as Buffer).toString('latin1');
    expect(dump).not.toMatch(/2012|birth|<tournament|<player|Nia/);
  });

  it("shows only the tournament's name and date, never the file's organizer or id", () => {
    const content = tomTdf({ organizerElement: '<organizer popid="5550001" name="Pat Organizer"/>' });

    const preview = previewFile(L, WED, { filename: 'cup.tdf', content });

    expect(preview.tournament).toEqual({ name: 'Wednesday League Challenge', date: '2026-10-14' });
    expect(JSON.stringify(preview)).not.toMatch(/5550001|Pat Organizer|popid|26-10-000123/);
  });

  it('throws TdfError for a file that is not a tournament', () => {
    expect(() => previewFile(L, WED, { filename: 'x.tdf', content: 'hello' })).toThrow(TdfError);
    expect(count('tdf_upload')).toBe(0);
  });

  it('returns the same upload when the same file is previewed again', () => {
    const content = tdf([{ userid: '1' }]);
    const first = previewFile(L, WED, { filename: 'cup.tdf', content });
    const again = previewFile(L, WED, { filename: 'renamed.tdf', content });

    expect(again.uploadId).toBe(first.uploadId);
    expect(count('tdf_upload')).toBe(1);
  });

  it('treats the same file on another date as a separate upload of the one archived file', () => {
    const content = tdf([{ userid: '1' }]);
    const wed = previewFile(L, WED, { filename: 'cup.tdf', content });
    const next = previewFile(L, NEXT_WED, { filename: 'cup.tdf', content });

    expect(next.uploadId).not.toBe(wed.uploadId);
    expect(archive.list(L)).toHaveLength(1);
    expect(new Set(uploadRows().map((u) => u.fileId)).size).toBe(1);
  });

  it('marks a file that was already imported for the date', () => {
    const content = tdf([{ userid: '1' }]);
    imports.commit(L, WED, previewFile(L, WED, { filename: 'cup.tdf', content }).uploadId);

    const again = previewFile(L, WED, { filename: 'cup.tdf', content });
    expect(again.alreadyImported).toBe(true);
    expect(again.players).toEqual([{ playerId: '1', name: '', status: 'listed' }]);
  });

  it('drops previews that were never committed after a day, and their archived files', () => {
    previewFile(L, WED, { filename: 'old.tdf', content: tdf([{ userid: '1' }]) });
    now = new Date(now.getTime() + 25 * 60 * 60 * 1000);

    previewFile(L, WED, { filename: 'new.tdf', content: tdf([{ userid: '2' }]) });

    expect(database.sqlite.prepare('select filename from tdf_upload').all()).toEqual([{ filename: 'new.tdf' }]);
    expect(archive.list(L).map((f) => f.filename)).toEqual(['new.tdf']);
  });

  it('expires abandoned previews on its own, without another drop (the hourly task)', () => {
    previewFile(L, WED, { filename: 'old.tdf', content: tdf([{ userid: '1' }]) });
    now = new Date(now.getTime() + 23 * 60 * 60 * 1000);
    expect(imports.expirePreviews()).toEqual({ uploads: 0, files: 0 });

    now = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    expect(imports.expirePreviews()).toEqual({ uploads: 1, files: 1 });
    expect(count('tdf_upload')).toBe(0);
    expect(count('tdf_file')).toBe(0);
  });

  it('keeps a file while a preview of it is pending, and for good once one is committed', () => {
    const content = tdf([{ userid: '1' }]);
    imports.commit(L, WED, previewFile(L, WED, { filename: 'cup.tdf', content }).uploadId);
    previewFile(L, NEXT_WED, { filename: 'cup.tdf', content });
    now = new Date(now.getTime() + 25 * 60 * 60 * 1000);

    imports.expirePreviews();

    expect(archive.list(L)).toEqual([expect.objectContaining({ keptFor: ['attendance'] })]);
    expect(uploadRows().map((u) => u.status)).toEqual(['committed']);
  });
});

describe('commit', () => {
  const previewAndCommit = (date: SessionDate, players: { userid: string; name?: string }[], filename = 'cup.tdf') =>
    imports.commit(L, date, previewFile(L, date, { filename, content: tdf(players, filename) }).uploadId);

  it('lists the non-regulars for the date, records every player as known, and logs a tdf sighting for each', () => {
    roster.addRegular(L, { playerId: id('3'), name: 'Regular Rae' });

    const result = previewAndCommit(WED, [
      { userid: '0001', name: 'New Nia' },
      { userid: '3', name: 'Regular Rae' },
    ]);

    expect(result).toEqual({ added: 1, alreadyListed: 0, regulars: 1, alreadyImported: false });
    expect(sessions.getSession(L, WED).players).toEqual([{ playerId: '0001', displayName: 'New Nia', source: 'tdf' }]);
    expect(roster.listPlayers(L).map((p) => p.playerId).sort()).toEqual(['0001', '3']);
    // Regulars are evidence too: the stale-regular metric needs their sightings (ADR-0005).
    expect(sightings.on(L, WED)).toEqual([
      { playerId: '0001', kind: 'tdf' },
      { playerId: '3', kind: 'tdf' },
    ]);
  });

  it('fills in a missing name but never overwrites one on file', () => {
    roster.ensurePlayers(L, [{ playerId: id('1') }, { playerId: id('2'), name: 'Known Kim' }]);

    previewAndCommit(WED, [
      { userid: '1', name: 'Nameless Ned' },
      { userid: '2', name: 'Other Name' },
    ]);

    expect(roster.getPlayers(L, [id('1'), id('2')]).map((p) => p.displayName).sort()).toEqual(['Known Kim', 'Nameless Ned']);
  });

  it('keeps a player who was added by hand as a manual entry, adding the tdf sighting alongside', () => {
    sessions.addPlayer(L, WED, { playerId: id('4'), name: 'Listed Lee' });

    const result = previewAndCommit(WED, [{ userid: '4' }]);

    expect(result).toMatchObject({ added: 0, alreadyListed: 1 });
    expect(sessions.getSession(L, WED).players).toEqual([{ playerId: '4', displayName: 'Listed Lee', source: 'manual' }]);
    expect(sightings.on(L, WED)).toEqual([
      { playerId: '4', kind: 'manual' },
      { playerId: '4', kind: 'tdf' },
    ]);
  });

  it('merges a second tournament on the same night by player ID', () => {
    previewAndCommit(WED, [{ userid: '1' }, { userid: '2' }], 'tcg.tdf');
    const result = previewAndCommit(WED, [{ userid: '2' }, { userid: '3' }], 'vgc.tdf');

    expect(result).toMatchObject({ added: 1, alreadyListed: 1 });
    expect(sessions.getSession(L, WED).players.map((p) => p.playerId).sort()).toEqual(['1', '2', '3']);
  });

  it('classifies against the state at commit time, not at preview time', () => {
    const { uploadId } = previewFile(L, WED, { filename: 'cup.tdf', content: tdf([{ userid: '5', name: 'Late Reg' }]) });
    roster.addRegular(L, { playerId: id('5') });

    expect(imports.commit(L, WED, uploadId)).toMatchObject({ added: 0, regulars: 1 });
    expect(sessions.getSession(L, WED).players).toEqual([]);
  });

  it('is a no-op the second time (double click, retry)', () => {
    const { uploadId } = previewFile(L, WED, { filename: 'cup.tdf', content: tdf([{ userid: '1' }]) });
    imports.commit(L, WED, uploadId);
    sessions.removePlayer(L, WED, id('1'));

    expect(imports.commit(L, WED, uploadId)).toEqual({ added: 0, alreadyListed: 0, regulars: 0, alreadyImported: true });
    // The organizer's removal stands.
    expect(sessions.getSession(L, WED).players).toEqual([]);
  });

  it('refuses an upload that belongs to another date', () => {
    const { uploadId } = previewFile(L, WED, { filename: 'cup.tdf', content: tdf([{ userid: '1' }]) });

    expect(() => imports.commit(L, NEXT_WED, uploadId)).toThrow(UploadNotFoundError);
    expect(sessions.getSession(L, NEXT_WED).players).toEqual([]);
  });

  it('refuses an upload that belongs to another league', () => {
    const { uploadId } = previewFile(OTHER, WED, { filename: 'cup.tdf', content: tdf([{ userid: '1' }]) });
    expect(() => imports.commit(L, WED, uploadId)).toThrow(UploadNotFoundError);
  });

  it('refuses an unknown upload', () => {
    expect(() => imports.commit(L, WED, 999)).toThrow(UploadNotFoundError);
  });

  it(`imports a full ${2000}-player file in one go`, () => {
    const players = Array.from({ length: 2000 }, (_, i) => ({ userid: String(100000 + i), name: `P ${i}` }));
    expect(previewAndCommit(WED, players)).toMatchObject({ added: 2000 });
    expect(sightings.on(L, WED)).toHaveLength(2000);
  });

  it('parses the players again from the archive and marks the file kept for attendance', () => {
    const { uploadId } = previewFile(L, WED, { filename: 'cup.tdf', content: tdf([{ userid: '1', name: 'New Nia' }]) });

    expect(imports.commit(L, WED, uploadId)).toMatchObject({ added: 1 });
    expect(archive.list(L)).toEqual([expect.objectContaining({ keptFor: ['attendance'] })]);
  });

  it('refuses to commit once the organizer deleted the file, importing nothing', () => {
    const { uploadId } = previewFile(L, WED, { filename: 'cup.tdf', content: tdf([{ userid: '1' }]) });
    archive.delete(L, archive.list(L)[0]!.id);

    expect(() => imports.commit(L, WED, uploadId)).toThrow(TdfFileDeletedError);
    expect(roster.listPlayers(L)).toEqual([]);
    expect(sightings.on(L, WED)).toEqual([]);
  });

  it("refuses to commit a file this install's key can't open, importing nothing", () => {
    const { uploadId } = previewFile(L, WED, { filename: 'cup.tdf', content: tdf([{ userid: '1' }]) });
    const otherKey = archiveWith(randomBytes(32).toString('base64'));
    imports = createTdfImportService({ db: database.db, roster, sightings, archive: otherKey, now: () => now });

    expect(() => imports.commit(L, WED, uploadId)).toThrow(TdfKeyMismatchError);
    expect(roster.listPlayers(L)).toEqual([]);
    expect(sightings.on(L, WED)).toEqual([]);
  });

  it('stores a deleted file afresh when it is dropped again, re-pointing the upload so it commits', () => {
    const content = tdf([{ userid: '1' }]);
    const { uploadId } = previewFile(L, WED, { filename: 'cup.tdf', content });
    archive.delete(L, archive.list(L)[0]!.id);

    expect(previewFile(L, WED, { filename: 'cup.tdf', content }).uploadId).toBe(uploadId);
    expect(uploadRows()[0]!.fileId).toBe(archive.list(L)[0]!.id);
    expect(imports.commit(L, WED, uploadId)).toMatchObject({ added: 1 });
  });

  it('shows the import on the session', () => {
    previewAndCommit(WED, [{ userid: '1' }, { userid: '2' }], 'tcg.tdf');

    expect(sessions.getSession(L, WED).imports).toEqual([
      { uploadId: expect.any(Number), filename: 'tcg.tdf', tournamentName: 'tcg.tdf', playerCount: 2, importedAt: now },
    ]);
  });

  it('does not show previews that were never committed on the session', () => {
    previewFile(L, WED, { filename: 'cup.tdf', content: tdf([{ userid: '1' }]) });
    expect(sessions.getSession(L, WED).imports).toEqual([]);
  });
});

describe('resetting a date after its play session was cleared', () => {
  const content = tdf([{ userid: '1' }, { userid: '2' }]);

  it('puts the draft back to draft and drops its committed imports, so the same file can be imported again', () => {
    imports.commit(L, WED, previewFile(L, WED, { filename: 'cup.tdf', content }).uploadId);
    sessions.recordSubmission(L, WED, { playSessionId: 'ps-1', status: 'submitted' });

    sessions.resetAfterClear(L, WED);

    expect(sessions.getSession(L, WED)).toMatchObject({ status: 'draft', imports: [] });
    // The file stays in the archive, kept, until the organizer deletes it.
    expect(archive.list(L)).toEqual([expect.objectContaining({ keptFor: ['attendance'] })]);
    const again = previewFile(L, WED, { filename: 'cup.tdf', content });
    expect(again.alreadyImported).toBe(false);
    expect(imports.commit(L, WED, again.uploadId)).toMatchObject({ alreadyImported: false });
  });

  it("leaves other dates and other leagues alone", () => {
    imports.commit(L, NEXT_WED, previewFile(L, NEXT_WED, { filename: 'cup.tdf', content }).uploadId);
    imports.commit(OTHER, WED, previewFile(OTHER, WED, { filename: 'cup.tdf', content }).uploadId);
    sessions.recordSubmission(L, NEXT_WED, { playSessionId: 'ps-2', status: 'submitted' });

    sessions.resetAfterClear(L, WED);

    expect(sessions.getSession(L, NEXT_WED)).toMatchObject({ status: 'submitted', imports: [expect.anything()] });
    expect(sessions.getSession(OTHER, WED).imports).toHaveLength(1);
  });

  it('is a no-op for a date with no draft', () => {
    sessions.resetAfterClear(L, WED);
    expect(count('session_draft')).toBe(0);
  });
});

describe('removing a session player who came from a TDF', () => {
  it('retracts their tdf sighting too: the organizer says they were not there', () => {
    imports.commit(L, WED, previewFile(L, WED, { filename: 'cup.tdf', content: tdf([{ userid: '1' }]) }).uploadId);

    expect(sessions.removePlayer(L, WED, id('1'))).toBe(true);
    expect(sightings.on(L, WED)).toEqual([]);
  });
});

describe('the attendance referrer: archived files and the imports that use them', () => {
  const original = tdf([{ userid: '1', name: 'Ash K' }, { userid: '2' }]);
  const corrected = (name: string) => tdf([{ userid: '1', name: 'Ash K' }, { userid: '2' }], name);

  it('re-points every import of a corrected file, keeping the sha256 of the file as dropped', () => {
    imports.commit(L, WED, previewFile(L, WED, { filename: 'cup.tdf', content: original }).uploadId);
    previewFile(L, NEXT_WED, { filename: 'cup.tdf', content: original });
    const before = uploadRows();

    const { fileId } = archive.replace(L, before[0]!.fileId!, { filename: 'cup.tdf', content: corrected('Fixed'), by: 'organizer' });

    expect(uploadRows()).toEqual(before.map((u) => ({ ...u, fileId })));
    expect(archive.list(L).map((f) => f.id)).toEqual([fileId]);
    expect(imports.commit(L, NEXT_WED, uploadRows()[1]!.id)).toMatchObject({ added: 2 });
    // A re-drop of the original is still recognised.
    expect(previewFile(L, WED, { filename: 'cup.tdf', content: original }).alreadyImported).toBe(true);
  });

  it('reports the imports of a deleted file, which keep their sha256 and show the file as deleted', () => {
    const { uploadId } = previewFile(L, WED, { filename: 'cup.tdf', content: original });
    imports.commit(L, WED, uploadId);
    const [before] = uploadRows();

    expect(archive.delete(L, before!.fileId!)).toEqual({ referencedBy: [{ kind: 'attendance', id: uploadId }] });
    expect(uploadRows()).toEqual([{ ...before, fileId: null }]);
    expect(sessions.getSession(L, WED).imports).toHaveLength(1);
  });

  it('never leaves an import pointing at a missing file, whatever the sequence', () => {
    const a = previewFile(L, WED, { filename: 'a.tdf', content: original }).uploadId;
    previewFile(L, NEXT_WED, { filename: 'b.tdf', content: tdf([{ userid: '3' }]) });
    imports.commit(L, WED, a);
    archive.replace(L, uploadRows()[0]!.fileId!, { filename: 'a.tdf', content: corrected('Fixed'), by: 'organizer' });
    now = new Date(now.getTime() + 25 * 60 * 60 * 1000);
    imports.expirePreviews();
    archive.delete(L, uploadRows()[0]!.fileId!);
    previewFile(L, WED, { filename: 'a.tdf', content: original });
    imports.expirePreviews();

    expect(dangling()).toBe(0);
    expect(uploadRows()).toEqual([expect.objectContaining({ id: a, fileId: archive.list(L)[0]!.id, status: 'committed' })]);
  });
});
