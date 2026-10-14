import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BIRTHDATE, type TomPlayer, tomTdf } from '../../../shared/tdf/__fixtures__/tom';
import { TdfError } from '../../../shared/tdf/parse';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import type { LogFields, Logger } from '@towerism/selfhost-kit';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import { createVault } from '../vault/vault';
import { TdfFileNotFoundError, TdfKeyMismatchError } from './errors';
import { type TdfArchiveService, type TdfFileReferrer, createTdfArchiveService } from './service';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const OTHER = 'other-league';
const T = new Date('2026-10-14T23:00:00Z');
const HOUR = 60 * 60 * 1000;

const players = (n: number): TomPlayer[] =>
  Array.from({ length: n }, (_, i) => ({ userid: String(1000000 + i), first: `First${i}`, last: `Last${i}` }));

let database: OpenDatabase;
let key: string;
let now: Date;
let logged: { level: string; msg: string; fields?: LogFields }[];
/** Stand-ins for the modules that point at files: attendance can be re-pointed, results (#96) can't. */
let attendanceRows: { id: number; fileId: number }[];
let resultsRows: { id: number; fileId: number }[];
let archive: TdfArchiveService;

function recordingLogger(): Logger {
  const at =
    (level: string) =>
    (msg: string, fields?: LogFields): void => {
      logged.push({ level, msg, fields });
    };
  const logger: Logger = { error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug'), child: () => logger };
  return logger;
}

function referrers(): TdfFileReferrer[] {
  return [
    {
      kind: 'attendance',
      referencing: (fileId) => attendanceRows.filter((r) => r.fileId === fileId).map((r) => r.id),
      repoint: (from, to) => attendanceRows.filter((r) => r.fileId === from).forEach((r) => (r.fileId = to)),
    },
    { kind: 'results', referencing: (fileId) => resultsRows.filter((r) => r.fileId === fileId).map((r) => r.id) },
  ];
}

function archiveWith(base64Key: string): TdfArchiveService {
  return createTdfArchiveService({
    db: database.db,
    vault: createVault(base64Key, 'tdf'),
    referrers,
    log: recordingLogger(),
    now: () => now,
  });
}

beforeEach(() => {
  database = openDatabase(':memory:');
  migrateDatabase(database.db, MIGRATIONS_DIR);
  database.sqlite.prepare("insert into league (id, name) values (?, 'Other')").run(OTHER);
  key = randomBytes(32).toString('base64');
  now = T;
  logged = [];
  attendanceRows = [];
  resultsRows = [];
  archive = archiveWith(key);
});
afterEach(() => database.close());

const rawRows = () => database.sqlite.prepare('select * from tdf_file order by id').all() as Record<string, unknown>[];
const store = (content: string, filename = 'cup.tdf', league = L) => archive.store(league, { filename, content, by: 'organizer' });

describe('store', () => {
  it('keeps the file encrypted, compressed and with its metadata, and nothing readable in the row', () => {
    const content = tomTdf({ players: players(30), name: 'Wed Cup', idElement: '<id>26-10-000999</id>' });

    const { fileId, sha256, alreadyStored } = store(content);

    expect(alreadyStored).toBe(false);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    const [row] = rawRows();
    expect(row).toMatchObject({
      id: fileId,
      league_id: L,
      sha256,
      filename: 'cup.tdf',
      byte_size: Buffer.byteLength(content),
      tournament_name: 'Wed Cup',
      tournament_date: '2026-10-14',
      tournament_display_id: '26-10-000999',
      kept_for: '[]',
      created_by: 'organizer',
      created_at: Math.floor(T.getTime() / 1000),
    });
    const ciphertext = row!.ciphertext as Buffer;
    for (const plain of [BIRTHDATE, 'First7', 'Last7', '1000007', '<tournament']) {
      expect(ciphertext.toString('latin1')).not.toContain(plain);
    }
    expect(ciphertext.length).toBeLessThan(Buffer.byteLength(content));
  });

  it('stores a file once per league: the same file again returns the same row', () => {
    const content = tomTdf();
    const first = store(content, 'a.tdf');

    expect(store(content, 'renamed.tdf')).toEqual({ fileId: first.fileId, sha256: first.sha256, alreadyStored: true });
    expect(rawRows()).toHaveLength(1);
    expect(store(content, 'a.tdf', OTHER).alreadyStored).toBe(false);
    expect(rawRows()).toHaveLength(2);
  });

  it('refuses a file the parser refuses, storing nothing', () => {
    expect(() => store('name,player_id\nAsh,1')).toThrow(TdfError);
    expect(() => store(tomTdf({ players: [] }))).toThrow(TdfError);
    expect(rawRows()).toEqual([]);
  });
});

describe('read', () => {
  it('gives back the file byte for byte', () => {
    const content = tomTdf({ players: [{ userid: '1', first: 'Café', last: 'Ünïcode' }], eol: '\r\n', bom: true });
    const { fileId } = store(content, 'Café Cup.tdf');

    expect(archive.read(L, fileId)).toEqual({ filename: 'Café Cup.tdf', content });
  });

  it('does not find another league’s file or an unknown id', () => {
    const { fileId } = store(tomTdf());
    expect(() => archive.read(OTHER, fileId)).toThrow(TdfFileNotFoundError);
    expect(() => archive.read(L, fileId + 1)).toThrow(TdfFileNotFoundError);
  });

  it('refuses under another key, and logs only the file id', () => {
    const { fileId } = store(tomTdf());

    expect(() => archiveWith(randomBytes(32).toString('base64')).read(L, fileId)).toThrow(TdfKeyMismatchError);
    expect(logged).toEqual([{ level: 'warn', msg: expect.stringMatching(/wrong key or tampered/), fields: { fileId } }]);
  });

  it('refuses a ciphertext copied onto another file’s row, or with a flipped byte', () => {
    const a = store(tomTdf({ name: 'A' })).fileId;
    const b = store(tomTdf({ name: 'B' })).fileId;
    database.sqlite.prepare('update tdf_file set ciphertext = (select ciphertext from tdf_file where id = ?) where id = ?').run(a, b);
    expect(() => archive.read(L, b)).toThrow(TdfKeyMismatchError);

    const blob = database.sqlite.prepare('select ciphertext from tdf_file where id = ?').pluck().get(a) as Buffer;
    blob[blob.length - 1]! ^= 0x01;
    database.sqlite.prepare('update tdf_file set ciphertext = ? where id = ?').run(blob, a);
    expect(() => archive.read(L, a)).toThrow(TdfKeyMismatchError);
  });
});

describe('list', () => {
  it('lists the league’s files newest first, metadata only, filtered by tournament id or date', () => {
    const a = store(tomTdf({ name: 'A', idElement: '<id>26-10-1</id>', startdate: '10/07/2026' }), 'a.tdf').fileId;
    now = new Date(T.getTime() + HOUR);
    const b = store(tomTdf({ name: 'B', idElement: '<id/>', startdate: '10/14/2026' }), 'b.tdf').fileId;
    now = new Date(T.getTime() + 2 * HOUR);
    const c = store(tomTdf({ name: 'C', idElement: '<id>26-10-3</id>', startdate: '10/14/2026' }), 'c.tdf').fileId;
    store(tomTdf({ name: 'Elsewhere' }), 'x.tdf', OTHER);

    const all = archive.list(L);
    expect(all.map((f) => f.id)).toEqual([c, b, a]);
    expect(all[2]).toEqual({
      id: a,
      filename: 'a.tdf',
      tournamentName: 'A',
      tournamentDate: '2026-10-07',
      tournamentId: '26-10-1',
      byteSize: expect.any(Number),
      keptFor: [],
      createdBy: 'organizer',
      createdAt: T,
    });
    expect(archive.list(L, { tournamentId: '26-10-3' }).map((f) => f.id)).toEqual([c]);
    expect(archive.list(L, { date: '2026-10-14' }).map((f) => f.id)).toEqual([c, b]);
    expect(JSON.stringify(all)).not.toContain(BIRTHDATE);
  });
});

describe('markKept', () => {
  it('adds each reason once, and never drops one', () => {
    const { fileId } = store(tomTdf());
    archive.markKept(fileId, 'attendance');
    archive.markKept(fileId, 'results');
    archive.markKept(fileId, 'attendance');

    expect(archive.list(L)[0]!.keptFor).toEqual(['attendance', 'results']);
  });
});

describe('expire', () => {
  it('after a day, deletes only files that are neither kept nor pointed at', () => {
    const abandoned = store(tomTdf({ name: 'abandoned' })).fileId;
    const kept = store(tomTdf({ name: 'kept' })).fileId;
    archive.markKept(kept, 'attendance');
    const pending = store(tomTdf({ name: 'pending' })).fileId;
    attendanceRows.push({ id: 1, fileId: pending });
    const inUpload = store(tomTdf({ name: 'results' })).fileId;
    resultsRows.push({ id: 7, fileId: inUpload });
    now = new Date(T.getTime() + HOUR);
    const fresh = store(tomTdf({ name: 'fresh' })).fileId;

    now = new Date(T.getTime() + 23 * HOUR);
    expect(archive.expire()).toEqual({ deleted: 0 });
    now = new Date(T.getTime() + 24 * HOUR);
    expect(archive.expire()).toEqual({ deleted: 0 });

    // Timestamps are stored in whole seconds.
    now = new Date(T.getTime() + 24 * HOUR + 1000);
    expect(archive.expire()).toEqual({ deleted: 1 });
    expect(archive.list(L).map((f) => f.id).sort()).toEqual([kept, pending, inUpload, fresh].sort());
    expect(() => archive.read(L, abandoned)).toThrow(TdfFileNotFoundError);
  });
});

describe('replace', () => {
  it('re-points the attendance imports to the corrected file and deletes the original, keeping its reasons', () => {
    const original = store(tomTdf({ idElement: '<id/>' }), 'cup.tdf').fileId;
    archive.markKept(original, 'attendance');
    attendanceRows.push({ id: 1, fileId: original }, { id: 2, fileId: original });
    const corrected = tomTdf({ idElement: '<id>26-10-000123</id>' });

    const { fileId } = archive.replace(L, original, { filename: 'cup.tdf', content: corrected, by: 'organizer' });

    expect(attendanceRows).toEqual([
      { id: 1, fileId },
      { id: 2, fileId },
    ]);
    expect(() => archive.read(L, original)).toThrow(TdfFileNotFoundError);
    expect(archive.read(L, fileId).content).toBe(corrected);
    expect(archive.list(L)).toEqual([expect.objectContaining({ id: fileId, keptFor: ['attendance'], tournamentId: '26-10-000123' })]);
  });

  it('keeps the original while a results upload still points at it', () => {
    const original = store(tomTdf({ idElement: '<id/>' })).fileId;
    attendanceRows.push({ id: 1, fileId: original });
    resultsRows.push({ id: 9, fileId: original });

    const { fileId } = archive.replace(L, original, { filename: 'cup.tdf', content: tomTdf(), by: 'organizer' });

    expect(attendanceRows).toEqual([{ id: 1, fileId }]);
    expect(archive.read(L, original).content).toBe(tomTdf({ idElement: '<id/>' }));
  });

  it('reuses an already-stored corrected file', () => {
    const existing = store(tomTdf(), 'fixed.tdf').fileId;
    const original = store(tomTdf({ idElement: '<id/>' })).fileId;
    attendanceRows.push({ id: 1, fileId: original });

    expect(archive.replace(L, original, { filename: 'cup.tdf', content: tomTdf(), by: 'organizer' })).toEqual({ fileId: existing });
    expect(attendanceRows).toEqual([{ id: 1, fileId: existing }]);
    expect(rawRows().map((r) => r.id)).toEqual([existing]);
  });

  it('does not replace another league’s file', () => {
    const original = store(tomTdf({ idElement: '<id/>' })).fileId;
    expect(() => archive.replace(OTHER, original, { filename: 'cup.tdf', content: tomTdf(), by: 'organizer' })).toThrow(TdfFileNotFoundError);
    expect(rawRows()).toHaveLength(1);
  });
});

describe('delete', () => {
  it('removes the ciphertext at once and reports the rows that pointed at it', () => {
    const { fileId } = store(tomTdf());
    attendanceRows.push({ id: 3, fileId }, { id: 4, fileId });
    resultsRows.push({ id: 8, fileId });

    expect(archive.delete(L, fileId)).toEqual({
      referencedBy: [
        { kind: 'attendance', id: 3 },
        { kind: 'attendance', id: 4 },
        { kind: 'results', id: 8 },
      ],
    });
    expect(rawRows()).toEqual([]);
  });

  it('does not find another league’s file or an unknown id', () => {
    const { fileId } = store(tomTdf());
    expect(() => archive.delete(OTHER, fileId)).toThrow(TdfFileNotFoundError);
    expect(() => archive.delete(L, fileId + 1)).toThrow(TdfFileNotFoundError);
    expect(rawRows()).toHaveLength(1);
  });

  it('deletes a file this install’s key cannot open', () => {
    const { fileId } = store(tomTdf());
    expect(archiveWith(randomBytes(32).toString('base64')).delete(L, fileId)).toEqual({ referencedBy: [] });
  });
});
