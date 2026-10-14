import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import { TournamentsError } from './errors';
import { type TournamentRequirements, createRequirements } from './requirements';

// Required events (ADR-0010 decision 12, #95): the requirements a league must meet, and manual covers.

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const NOW = new Date('2026-10-14T17:00:00Z');

let database: OpenDatabase;
let requirements: TournamentRequirements;

beforeEach(() => {
  database = openDatabase(':memory:');
  migrateDatabase(database.db, MIGRATIONS_DIR);
  requirements = createRequirements({ db: database.db, now: () => NOW });
});
afterEach(() => database.close());

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    if (err instanceof TournamentsError) return err.code;
    throw err;
  }
  throw new Error('expected a refusal');
}

const SEEDS = [
  { seriesMatch: 'League Cup', product: 'tcg', cadence: 'quarter', minCount: 1, warnDays: 45, active: true },
  { seriesMatch: 'League Cup', product: 'vg', cadence: 'quarter', minCount: 1, warnDays: 45, active: true },
  { seriesMatch: 'League Cup', product: 'pgo', cadence: 'quarter', minCount: 1, warnDays: 45, active: true },
  { seriesMatch: 'League Challenge', product: 'tcg', cadence: 'month', minCount: 1, warnDays: 21, active: true },
  { seriesMatch: 'League Challenge', product: 'vg', cadence: 'month', minCount: 1, warnDays: 21, active: true },
  { seriesMatch: 'League Challenge', product: 'pgo', cadence: 'month', minCount: 1, warnDays: 21, active: true },
];

describe('seeding', () => {
  it("seeds the organizer's six requirements once, in order", () => {
    requirements.list(L);
    const listed = requirements.list(L);
    expect(listed.map(({ id: _id, ...r }) => r)).toEqual(SEEDS);
    expect(database.sqlite.prepare('select count(*) as n from tournament_requirement').get()).toEqual({ n: 6 });
  });

  it('seeds on any first operation, not only a list', () => {
    requirements.create(L, { seriesMatch: 'Prerelease', product: 'tcg', cadence: 'month' });
    expect(requirements.list(L)).toHaveLength(7);
  });

  it('never seeds again once every row is turned off', () => {
    for (const r of requirements.list(L)) requirements.update(L, r.id, { active: false });
    expect(requirements.active(L)).toEqual([]);
    expect(requirements.list(L)).toHaveLength(6);
  });
});

describe('creating and editing', () => {
  it('defaults the minimum count, the warning lead by cadence, and on', () => {
    const month = requirements.create(L, { seriesMatch: 'Prerelease', product: 'tcg', cadence: 'month' });
    const quarter = requirements.create(L, { seriesMatch: 'Regional Qualifier', product: 'vg', cadence: 'quarter' });
    expect(month).toMatchObject({ seriesMatch: 'Prerelease', minCount: 1, warnDays: 21, active: true });
    expect(quarter).toMatchObject({ warnDays: 45 });
    expect(requirements.create(L, { seriesMatch: ' Midseason ', product: 'pgo', cadence: 'month', minCount: 2, warnDays: 10, active: false })).toMatchObject({
      seriesMatch: 'Midseason',
      minCount: 2,
      warnDays: 10,
      active: false,
    });
  });

  it('refuses a duplicate product, cadence and series match, ignoring case and spaces', () => {
    expect(refusal(() => requirements.create(L, { seriesMatch: ' league cup ', product: 'tcg', cadence: 'quarter' }))).toBe('requirement_exists');
    expect(requirements.create(L, { seriesMatch: 'league cup', product: 'tcg', cadence: 'month' }).cadence).toBe('month');
  });

  it('changes any field, keeping the duplicate rule', () => {
    const [cup, , , challenge] = requirements.list(L);
    expect(requirements.update(L, challenge!.id, { warnDays: 14, minCount: 2 })).toMatchObject({ warnDays: 14, minCount: 2, seriesMatch: 'League Challenge' });
    expect(refusal(() => requirements.update(L, challenge!.id, { seriesMatch: 'LEAGUE CUP', cadence: 'quarter' }))).toBe('requirement_exists');
    expect(requirements.update(L, cup!.id, { seriesMatch: 'League Cup' }).seriesMatch).toBe('League Cup');
  });

  it("refuses a cadence change while the requirement has covers, since they're the old cadence's periods", () => {
    const [cup] = requirements.list(L);
    requirements.putCover(L, cup!.id, '2026-10-01', { note: 'run by Prof Oak' }, 'organizer');
    expect(refusal(() => requirements.update(L, cup!.id, { cadence: 'month' }))).toBe('requirement_has_covers');
    expect(requirements.update(L, cup!.id, { warnDays: 30 }).warnDays).toBe(30);
  });

  it('answers not found for another id or league', () => {
    expect(refusal(() => requirements.update(L, 999, { active: false }))).toBe('not_found');
    expect(refusal(() => requirements.putCover(L, 999, '2026-10-01', { note: 'x' }, 'o'))).toBe('not_found');
  });

  it('caps a league at 50 requirements', () => {
    for (let i = 0; i < 44; i++) requirements.create(L, { seriesMatch: `Event ${i}`, product: 'tcg', cadence: 'month' });
    expect(requirements.list(L)).toHaveLength(50);
    expect(refusal(() => requirements.create(L, { seriesMatch: 'One more', product: 'tcg', cadence: 'month' }))).toBe('too_many_requirements');
  });
});

describe('manual covers', () => {
  it('records, replaces and removes the cover for a period', () => {
    const [cup] = requirements.list(L);
    expect(requirements.putCover(L, cup!.id, '2026-10-01', { note: ' run by Prof Oak, 26-10-1 ' }, 'organizer')).toEqual({
      periodStart: '2026-10-01',
      note: 'run by Prof Oak, 26-10-1',
      createdBy: 'organizer',
      createdAt: NOW.toISOString(),
    });
    requirements.putCover(L, cup!.id, '2026-10-01', { note: 'run by Prof Elm' }, 'helper');
    expect(requirements.covers(L)).toEqual([
      { requirementId: cup!.id, periodStart: '2026-10-01', note: 'run by Prof Elm', createdBy: 'helper', createdAt: NOW.toISOString() },
    ]);
    requirements.deleteCover(L, cup!.id, '2026-10-01');
    expect(requirements.covers(L)).toEqual([]);
    expect(refusal(() => requirements.deleteCover(L, cup!.id, '2026-10-01'))).toBe('not_found');
  });

  it("refuses a period start that isn't the first day of one of the cadence's periods", () => {
    const [cup, , , challenge] = requirements.list(L);
    expect(refusal(() => requirements.putCover(L, cup!.id, '2026-11-01', { note: 'x' }, 'o'))).toBe('invalid_period');
    expect(refusal(() => requirements.putCover(L, challenge!.id, '2026-11-02', { note: 'x' }, 'o'))).toBe('invalid_period');
    expect(requirements.putCover(L, challenge!.id, '2026-11-01', { note: 'x' }, 'o').periodStart).toBe('2026-11-01');
  });

  it('answers with the cover as it was stored, to the second', () => {
    const [cup] = requirements.list(L);
    const withMs = createRequirements({ db: database.db, now: () => new Date('2026-10-14T17:00:00.789Z') });
    const put = withMs.putCover(L, cup!.id, '2026-10-01', { note: 'x' }, 'o');
    expect(put.createdAt).toBe('2026-10-14T17:00:00.000Z');
    expect(withMs.covers(L)[0]).toMatchObject(put);
  });

  it('keeps the covers of a requirement turned off', () => {
    const [cup] = requirements.list(L);
    requirements.putCover(L, cup!.id, '2026-10-01', { note: 'x' }, 'o');
    requirements.update(L, cup!.id, { active: false });
    expect(requirements.covers(L)).toHaveLength(1);
  });
});
