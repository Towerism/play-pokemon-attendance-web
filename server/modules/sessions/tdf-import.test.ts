import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tomTdf } from '../../../shared/tdf/__fixtures__/tom';
import { TdfError } from '../../../shared/tdf/parse';
import type { PlayerId, SessionDate } from '../../../shared/types/ids';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import { type SightingsService, createSightingsService } from '../metrics/sightings';
import { type RosterService, createRosterService } from '../roster/service';
import { type SessionsService, createSessionsService } from './service';
import { type TdfImportService, UploadNotFoundError, createTdfImportService } from './tdf-import';

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
let imports: TdfImportService;
let now: Date;

beforeEach(() => {
  database = openDatabase(':memory:');
  migrateDatabase(database.db, MIGRATIONS_DIR);
  database.sqlite.prepare("insert into league (id, name) values (?, 'Other')").run(OTHER);
  roster = createRosterService({ db: database.db });
  sightings = createSightingsService({ db: database.db });
  sessions = createSessionsService({ db: database.db, roster, sightings });
  now = new Date('2026-10-14T23:00:00Z');
  imports = createTdfImportService({ db: database.db, roster, sightings, now: () => now });
});
afterEach(() => database.close());

const count = (table: string) => (database.sqlite.prepare(`select count(*) n from ${table}`).get() as { n: number }).n;

describe('preview', () => {
  it('classifies each player against the league: new, known, regular, or already listed for the date', () => {
    roster.ensurePlayers(L, [{ playerId: id('2'), name: 'Known Kim' }]);
    roster.addRegular(L, { playerId: id('3'), name: 'Regular Rae' });
    sessions.addPlayer(L, WED, { playerId: id('4'), name: 'Listed Lee' });

    const preview = imports.preview(L, WED, {
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
    const preview = imports.preview(L, WED, {
      filename: 'cup.tdf',
      content: tdf([{ userid: '1' }, { userid: 'nope', name: 'Bad Row' }, { userid: '1' }]),
    });

    expect(preview.counts).toMatchObject({ new: 1, invalid: 1, duplicates: 1 });
    expect(preview.invalid).toEqual([{ name: 'Bad Row', reason: expect.any(String) }]);
  });

  it('changes nothing in the roster, session or sightings', () => {
    imports.preview(L, WED, { filename: 'cup.tdf', content: tdf([{ userid: '1', name: 'New Nia' }]) });

    expect(roster.listPlayers(L)).toEqual([]);
    expect(sessions.getSession(L, WED).players).toEqual([]);
    expect(sightings.on(L, WED)).toEqual([]);
  });

  it('does not keep the raw file or birthdates', () => {
    imports.preview(L, WED, { filename: 'cup.tdf', content: tdf([{ userid: '1', name: 'New Nia' }]) });

    const dump = JSON.stringify(database.sqlite.prepare('select * from tdf_upload').all()) +
      JSON.stringify(database.sqlite.prepare('select * from tdf_upload_player').all());
    expect(dump).not.toMatch(/2012|birth|<tournament|<player/);
  });

  it("shows only the tournament's name and date, never the file's organizer or id", () => {
    const content = tomTdf({ organizerElement: '<organizer popid="5550001" name="Pat Organizer"/>' });

    const preview = imports.preview(L, WED, { filename: 'cup.tdf', content });

    expect(preview.tournament).toEqual({ name: 'Wednesday League Challenge', date: '2026-10-14' });
    expect(JSON.stringify(preview)).not.toMatch(/5550001|Pat Organizer|popid|26-10-000123/);
  });

  it('throws TdfError for a file that is not a tournament', () => {
    expect(() => imports.preview(L, WED, { filename: 'x.tdf', content: 'hello' })).toThrow(TdfError);
    expect(count('tdf_upload')).toBe(0);
  });

  it('returns the same upload when the same file is previewed again', () => {
    const content = tdf([{ userid: '1' }]);
    const first = imports.preview(L, WED, { filename: 'cup.tdf', content });
    const again = imports.preview(L, WED, { filename: 'renamed.tdf', content });

    expect(again.uploadId).toBe(first.uploadId);
    expect(count('tdf_upload')).toBe(1);
  });

  it('treats the same file on another date as a separate upload', () => {
    const content = tdf([{ userid: '1' }]);
    const wed = imports.preview(L, WED, { filename: 'cup.tdf', content });
    const next = imports.preview(L, NEXT_WED, { filename: 'cup.tdf', content });

    expect(next.uploadId).not.toBe(wed.uploadId);
  });

  it('marks a file that was already imported for the date', () => {
    const content = tdf([{ userid: '1' }]);
    imports.commit(L, WED, imports.preview(L, WED, { filename: 'cup.tdf', content }).uploadId);

    const again = imports.preview(L, WED, { filename: 'cup.tdf', content });
    expect(again.alreadyImported).toBe(true);
    expect(again.players).toEqual([{ playerId: '1', name: '', status: 'listed' }]);
  });

  it('drops previews that were never committed after a day', () => {
    imports.preview(L, WED, { filename: 'old.tdf', content: tdf([{ userid: '1' }]) });
    now = new Date(now.getTime() + 25 * 60 * 60 * 1000);

    imports.preview(L, WED, { filename: 'new.tdf', content: tdf([{ userid: '2' }]) });

    expect(database.sqlite.prepare('select filename from tdf_upload').all()).toEqual([{ filename: 'new.tdf' }]);
    expect(count('tdf_upload_player')).toBe(1);
  });
});

describe('commit', () => {
  const previewAndCommit = (date: SessionDate, players: { userid: string; name?: string }[], filename = 'cup.tdf') =>
    imports.commit(L, date, imports.preview(L, date, { filename, content: tdf(players, filename) }).uploadId);

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
    const { uploadId } = imports.preview(L, WED, { filename: 'cup.tdf', content: tdf([{ userid: '5', name: 'Late Reg' }]) });
    roster.addRegular(L, { playerId: id('5') });

    expect(imports.commit(L, WED, uploadId)).toMatchObject({ added: 0, regulars: 1 });
    expect(sessions.getSession(L, WED).players).toEqual([]);
  });

  it('is a no-op the second time (double click, retry)', () => {
    const { uploadId } = imports.preview(L, WED, { filename: 'cup.tdf', content: tdf([{ userid: '1' }]) });
    imports.commit(L, WED, uploadId);
    sessions.removePlayer(L, WED, id('1'));

    expect(imports.commit(L, WED, uploadId)).toEqual({ added: 0, alreadyListed: 0, regulars: 0, alreadyImported: true });
    // The organizer's removal stands.
    expect(sessions.getSession(L, WED).players).toEqual([]);
  });

  it('refuses an upload that belongs to another date', () => {
    const { uploadId } = imports.preview(L, WED, { filename: 'cup.tdf', content: tdf([{ userid: '1' }]) });

    expect(() => imports.commit(L, NEXT_WED, uploadId)).toThrow(UploadNotFoundError);
    expect(sessions.getSession(L, NEXT_WED).players).toEqual([]);
  });

  it('refuses an upload that belongs to another league', () => {
    const { uploadId } = imports.preview(OTHER, WED, { filename: 'cup.tdf', content: tdf([{ userid: '1' }]) });
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

  it('shows the import on the session', () => {
    previewAndCommit(WED, [{ userid: '1' }, { userid: '2' }], 'tcg.tdf');

    expect(sessions.getSession(L, WED).imports).toEqual([
      { uploadId: expect.any(Number), filename: 'tcg.tdf', tournamentName: 'tcg.tdf', playerCount: 2, importedAt: now },
    ]);
  });

  it('does not show previews that were never committed on the session', () => {
    imports.preview(L, WED, { filename: 'cup.tdf', content: tdf([{ userid: '1' }]) });
    expect(sessions.getSession(L, WED).imports).toEqual([]);
  });
});

describe('resetting a date after its play session was cleared', () => {
  const content = tdf([{ userid: '1' }, { userid: '2' }]);

  it('puts the draft back to draft and drops its committed imports, so the same file can be imported again', () => {
    imports.commit(L, WED, imports.preview(L, WED, { filename: 'cup.tdf', content }).uploadId);
    sessions.recordSubmission(L, WED, { playSessionId: 'ps-1', status: 'submitted' });

    sessions.resetAfterClear(L, WED);

    expect(sessions.getSession(L, WED)).toMatchObject({ status: 'draft', imports: [] });
    expect(count('tdf_upload_player')).toBe(0);
    const again = imports.preview(L, WED, { filename: 'cup.tdf', content });
    expect(again.alreadyImported).toBe(false);
    expect(imports.commit(L, WED, again.uploadId)).toMatchObject({ alreadyImported: false });
  });

  it("leaves other dates and other leagues alone", () => {
    imports.commit(L, NEXT_WED, imports.preview(L, NEXT_WED, { filename: 'cup.tdf', content }).uploadId);
    imports.commit(OTHER, WED, imports.preview(OTHER, WED, { filename: 'cup.tdf', content }).uploadId);
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
    imports.commit(L, WED, imports.preview(L, WED, { filename: 'cup.tdf', content: tdf([{ userid: '1' }]) }).uploadId);

    expect(sessions.removePlayer(L, WED, id('1'))).toBe(true);
    expect(sightings.on(L, WED)).toEqual([]);
  });
});
