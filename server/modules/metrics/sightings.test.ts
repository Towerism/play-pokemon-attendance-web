import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlayerId, SessionDate } from '../../../shared/types/ids';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import { createRosterService } from '../roster/service';
import { type SightingsService, createSightingsService } from './sightings';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const id = (s: string) => s as PlayerId;
const WED = '2026-10-14' as SessionDate;
const NEXT_WED = '2026-10-21' as SessionDate;

let database: OpenDatabase;
let sightings: SightingsService;

beforeEach(() => {
  database = openDatabase(':memory:');
  migrateDatabase(database.db, MIGRATIONS_DIR);
  createRosterService({ db: database.db }).ensurePlayers(L, [{ playerId: id('1') }, { playerId: id('2') }]);
  sightings = createSightingsService({ db: database.db });
});
afterEach(() => database.close());

describe('sightings', () => {
  it('records one sighting per player, date and kind, however often it is recorded', () => {
    sightings.record(L, WED, 'manual', [id('1'), id('2')]);
    sightings.record(L, WED, 'manual', [id('1')]);

    expect(sightings.on(L, WED)).toEqual([
      { playerId: '1', kind: 'manual' },
      { playerId: '2', kind: 'manual' },
    ]);
  });

  it('keeps different kinds and dates apart', () => {
    sightings.record(L, WED, 'manual', [id('1')]);
    sightings.record(L, WED, 'tdf', [id('1')]);
    sightings.record(L, NEXT_WED, 'manual', [id('2')]);

    expect(sightings.on(L, WED)).toEqual([
      { playerId: '1', kind: 'manual' },
      { playerId: '1', kind: 'tdf' },
    ]);
  });

  it('retracts only the given kind on the given date', () => {
    sightings.record(L, WED, 'manual', [id('1')]);
    sightings.record(L, WED, 'tdf', [id('1')]);
    sightings.record(L, NEXT_WED, 'manual', [id('1')]);

    sightings.retract(L, WED, 'manual', [id('1')]);

    expect(sightings.on(L, WED)).toEqual([{ playerId: '1', kind: 'tdf' }]);
    expect(sightings.on(L, NEXT_WED)).toEqual([{ playerId: '1', kind: 'manual' }]);
  });

  it('does nothing for an empty list', () => {
    sightings.record(L, WED, 'manual', []);
    sightings.retract(L, WED, 'manual', []);
    expect(sightings.on(L, WED)).toEqual([]);
  });
});
