import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import { TournamentsError } from './errors';
import { type Template, type TournamentsService, createTournamentsService } from './service';
import { stubPlayTools, templateBody } from './test-helpers';

// Planning on read and replanning after edits (ADR-0010 decision 4): the module against an in-memory database
// with the real migrations, a stub play-tools, and a fixed clock.

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const TZ = 'America/Chicago';
/** Wednesday 2026-10-14, noon in Chicago. The creatable window starts Monday the 12th. */
const NOON_WED = new Date('2026-10-14T17:00:00Z');
const TUESDAYS = { kind: 'weekly', weekday: 2, every: 1 } as const;

let database: OpenDatabase;
let upstream: ReturnType<typeof stubPlayTools>;
let service: TournamentsService;
let template: Template;

beforeEach(() => {
  database = openDatabase(':memory:');
  migrateDatabase(database.db, MIGRATIONS_DIR);
  upstream = stubPlayTools();
  service = createTournamentsService({ db: database.db, connections: upstream.connections, gateway: upstream.gateway, timeZone: TZ, now: () => NOON_WED });
  template = service.createTemplate(L, templateBody({ type: { kind: 'custom' }, startTime: '18:00' }));
});
afterEach(() => database.close());

interface Row {
  id: number;
  schedule_id: number | null;
  slot_position: number | null;
  occurrence_date: string | null;
  local_date: string;
  start_time: string;
  state: string;
}
const rows = (): Row[] =>
  database.sqlite
    .prepare('select id, schedule_id, slot_position, occurrence_date, local_date, start_time, state from planned_tournament order by local_date, start_time, slot_position, id')
    .all() as Row[];
const setState = (id: number, state: string) => database.sqlite.prepare('update planned_tournament set state = ? where id = ?').run(state, id);
const read = () => service.upcoming(L, {});

function weekly(opts: { horizonWeeks?: number; slots?: { dayOffset?: number; startTime?: string | null }[] } = {}) {
  const scaffold = service.createScaffold(L, {
    name: 'Tuesday',
    slots: (opts.slots ?? [{}]).map((s) => ({ templateId: template.id, dayOffset: 0, startTime: null, ...s })),
  });
  const schedule = service.createSchedule(L, { scaffoldId: scaffold.id, rule: TUESDAYS, startsOn: '2026-09-01', endsOn: null, horizonWeeks: opts.horizonWeeks ?? 8 });
  return { scaffold, schedule };
}

async function refusal(run: () => unknown, code: string) {
  const err = await Promise.resolve()
    .then(run)
    .then(
      () => null,
      (e: unknown) => e,
    );
  expect(err).toBeInstanceOf(TournamentsError);
  expect((err as TournamentsError).code).toBe(code);
  return err as TournamentsError;
}

describe('materialising on read', () => {
  it('plans one row per scaffold date and slot from today − 2 days to today + horizon, once', async () => {
    weekly();
    await read();
    // Tuesdays from Mon Oct 12 to Wed Dec 9 (today + 56 days).
    expect(rows().map((r) => r.occurrence_date)).toEqual(['2026-10-13', '2026-10-20', '2026-10-27', '2026-11-03', '2026-11-10', '2026-11-17', '2026-11-24', '2026-12-01', '2026-12-08']);
    expect(rows().every((r) => r.state === 'planned' && r.start_time === '18:00')).toBe(true);
    await read();
    expect(rows()).toHaveLength(9);
  });

  it('adds nothing for a paused schedule, an archived one, or one whose scaffold is archived', async () => {
    const paused = weekly();
    service.updateSchedule(L, paused.schedule.id, { paused: true });
    const archived = weekly();
    service.archiveSchedule(L, archived.schedule.id);
    const orphan = weekly();
    database.sqlite.prepare('update tournament_scaffold set archived_at = 1 where id = ?').run(orphan.scaffold.id);
    await read();
    expect(rows()).toEqual([]);
  });

  it('won’t plan an event a one-off already holds (same template, date and time)', async () => {
    service.createPlanned(L, { templateId: template.id, localDate: '2026-10-20' });
    weekly();
    await read();
    expect(rows().filter((r) => r.local_date === '2026-10-20')).toEqual([expect.objectContaining({ schedule_id: null })]);
  });
});

describe('replanning after an edit', () => {
  it('deletes only rows not in play-tools that no longer fit, and keeps the rest out of the schedule', async () => {
    const { schedule } = weekly({ horizonWeeks: 1 });
    await read();
    // Tue Oct 13 and Oct 20: give them every state there is, on extra rows of a second slot too.
    const states = ['planned', 'skipped', 'failed', 'creating', 'unknown', 'created', 'cancelled'];
    const [oct13, oct20] = rows();
    setState(oct13!.id, 'created');
    setState(oct20!.id, 'skipped');
    const extra = states.map((state, i) =>
      database.sqlite
        .prepare(
          `insert into planned_tournament (league_id, schedule_id, slot_position, occurrence_date, template_id, local_date, start_time, state, created_at)
           values (?, ?, ?, '2026-10-20', ?, '2026-10-20', '18:00', ?, 0)`,
        )
        .run(L, schedule.id, i + 1, template.id, state).lastInsertRowid as number,
    );
    // An old row before the window start: history, never touched.
    database.sqlite
      .prepare(
        `insert into planned_tournament (league_id, schedule_id, slot_position, occurrence_date, template_id, local_date, start_time, state, created_at)
         values (?, ?, 0, '2026-10-06', ?, '2026-10-06', '18:00', 'planned', 0)`,
      )
      .run(L, schedule.id, template.id);

    service.updateSchedule(L, schedule.id, { rule: { kind: 'weekly', weekday: 4, every: 1 } });

    const kept = rows();
    expect(kept.filter((r) => r.occurrence_date === '2026-10-06')).toHaveLength(1);
    expect(kept.filter((r) => r.occurrence_date === '2026-10-20').map((r) => r.state).sort()).toEqual(['cancelled', 'created', 'creating', 'unknown']);
    expect(kept.find((r) => r.id === oct13!.id)?.state).toBe('created');
    expect(kept.some((r) => r.id === oct20!.id)).toBe(false);
    expect(kept.some((r) => extra.slice(0, 3).includes(r.id))).toBe(false);
    // Thursdays from the window start to today + 1 week (Oct 21): Oct 15.
    expect(kept.filter((r) => r.state === 'planned').map((r) => r.occurrence_date)).toEqual(['2026-10-06', '2026-10-15']);

    const upcoming = await read();
    const created = upcoming.tournaments.find((t) => t.plannedId === oct13!.id)!;
    expect(created.inSchedule).toBe(false);
    expect(upcoming.tournaments.find((t) => t.occurrenceDate === '2026-10-15')?.inSchedule).toBe(true);
  });

  it('keeps a skipped row that still fits skipped when only the horizon changes', async () => {
    const { schedule } = weekly();
    await read();
    const [first] = rows();
    service.updatePlanned(L, first!.id, { skipped: true });
    service.updateSchedule(L, schedule.id, { horizonWeeks: 2 });
    expect(rows().find((r) => r.id === first!.id)?.state).toBe('skipped');
  });

  it('moves rows not in play-tools to a slot’s new start time, except one whose time was set on the row', async () => {
    const { scaffold } = weekly({ horizonWeeks: 2, slots: [{ startTime: '12:00' }] });
    await read();
    const [own, moved, held] = rows();
    service.updatePlanned(L, own!.id, { startTime: '19:30' });
    setState(held!.id, 'creating');
    service.updateScaffold(L, scaffold.id, { slots: [{ templateId: template.id, dayOffset: 0, startTime: '13:00' }] });
    const after = new Map(rows().map((r) => [r.id, r.start_time]));
    expect(after.get(own!.id)).toBe('19:30');
    expect(after.get(moved!.id)).toBe('13:00');
    expect(after.get(held!.id)).toBe('12:00');
  });

  it('archiving a schedule deletes its rows not yet in play-tools', async () => {
    const { schedule } = weekly({ horizonWeeks: 1 });
    await read();
    const [first] = rows();
    setState(first!.id, 'created');
    service.archiveSchedule(L, schedule.id);
    expect(rows().map((r) => r.id)).toEqual([first!.id]);
  });
});

describe('one-off planned tournaments', () => {
  it('plans one at the template’s time by default, or the time given', async () => {
    const planned = service.createPlanned(L, { templateId: template.id, localDate: '2026-10-24' });
    expect(planned).toMatchObject({ plannedId: expect.any(Number), scheduleId: null, localDate: '2026-10-24', startTime: '18:00', state: 'planned', sanctionBy: '2026-10-17' });
    expect(service.createPlanned(L, { templateId: template.id, localDate: '2026-10-24', startTime: '19:00' }).startTime).toBe('19:00');
  });

  it('refuses a second row for the same event, naming the first, unless it was cancelled', async () => {
    const first = service.createPlanned(L, { templateId: template.id, localDate: '2026-10-24' });
    const err = await refusal(() => service.createPlanned(L, { templateId: template.id, localDate: '2026-10-24', startTime: '18:00' }), 'already_planned');
    expect(err.details).toEqual({ plannedTournamentId: first.plannedId });
    setState(first.plannedId!, 'cancelled');
    expect(service.createPlanned(L, { templateId: template.id, localDate: '2026-10-24' }).plannedId).not.toBe(first.plannedId);
  });

  it('refuses a scheduled row’s event too', async () => {
    weekly();
    await read();
    await refusal(() => service.createPlanned(L, { templateId: template.id, localDate: '2026-10-20' }), 'already_planned');
  });

  it.each([
    ['2026-10-11', 'date_too_far_past'],
    ['2027-10-15', 'date_too_far_ahead'],
  ])('refuses %s: %s', async (localDate, code) => {
    await refusal(() => service.createPlanned(L, { templateId: template.id, localDate }), code);
  });

  it('accepts both ends of the window', () => {
    expect(service.createPlanned(L, { templateId: template.id, localDate: '2026-10-12' }).state).toBe('planned');
    expect(service.createPlanned(L, { templateId: template.id, localDate: '2027-10-14' }).state).toBe('planned');
  });

  describe('with details changed from the template (#162)', () => {
    const stored = (id: number) =>
      database.sqlite.prepare('select overrides, series_override as seriesOverride from planned_tournament where id = ?').get(id) as {
        overrides: string;
        seriesOverride: string | null;
      };

    it('stores nothing over the template when nothing is changed', () => {
      const planned = service.createPlanned(L, { templateId: template.id, localDate: '2026-10-24' });
      expect(stored(planned.plannedId!)).toEqual({ overrides: '{}', seriesOverride: null });
    });

    it('stores exactly the details given and the type, and shows them on the entry', () => {
      const premier = service.createTemplate(L, templateBody({ name: 'League Challenge {month}', type: { kind: 'premier', seriesMatch: 'League Challenge' } }));
      const planned = service.createPlanned(L, {
        templateId: premier.id,
        localDate: '2026-10-24',
        overrides: { name: 'Halloween Cup', category: 'tcg_exp' },
        seriesId: 'custom',
      });
      expect(planned).toMatchObject({ name: 'Halloween Cup', category: 'tcg_exp', type: { kind: 'custom' } });
      expect(stored(planned.plannedId!)).toEqual({ overrides: JSON.stringify({ name: 'Halloween Cup', category: 'tcg_exp' }), seriesOverride: 'custom' });
    });

    it('is still one row per event, whatever the details', async () => {
      const first = service.createPlanned(L, { templateId: template.id, localDate: '2026-10-24' });
      const err = await refusal(
        () => service.createPlanned(L, { templateId: template.id, localDate: '2026-10-24', overrides: { name: 'Halloween Cup' } }),
        'already_planned',
      );
      expect(err.details).toEqual({ plannedTournamentId: first.plannedId });
      expect(service.createPlanned(L, { templateId: template.id, localDate: '2026-10-24', startTime: '19:00', overrides: { name: 'Halloween Cup' } }).state).toBe('planned');
    });

    it('keeps what it changed when the template is edited later, and follows the template for the rest', async () => {
      const planned = service.createPlanned(L, { templateId: template.id, localDate: '2026-10-24', overrides: { name: 'Halloween Cup' } });
      service.updateTemplate(L, template.id, { name: 'Friday Night Cup', category: 'tcg_exp' });
      const entry = (await read()).tournaments.find((e) => e.plannedId === planned.plannedId)!;
      expect(entry).toMatchObject({ name: 'Halloween Cup', category: 'tcg_exp' });
    });

    it.each([
      ['clears the only contact', { contactEmail: null }],
      ['clears both contacts', { contactEmail: null, contactPhone: null }],
    ])('refuses a one-off that %s', async (_, overrides) => {
      await refusal(() => service.createPlanned(L, { templateId: template.id, localDate: '2026-10-24', overrides }), 'contact_required');
      expect(rows()).toEqual([]);
    });

    it('takes a cleared contact when the other one stays', () => {
      const phoned = service.createTemplate(L, templateBody({ name: 'Phoned', contactPhone: '555-0100' }));
      expect(service.createPlanned(L, { templateId: phoned.id, localDate: '2026-10-24', overrides: { contactEmail: null } }).state).toBe('planned');
    });
  });

  it('refuses an unknown or archived template', async () => {
    await refusal(() => service.createPlanned(L, { templateId: 9999, localDate: '2026-10-24' }), 'unknown_template');
    service.archiveTemplate(L, template.id);
    await refusal(() => service.createPlanned(L, { templateId: template.id, localDate: '2026-10-24' }), 'template_archived');
  });
});

describe('changing a planned tournament', () => {
  it('skips and unskips, with no upstream call', () => {
    const { plannedId } = service.createPlanned(L, { templateId: template.id, localDate: '2026-10-24' });
    expect(service.updatePlanned(L, plannedId!, { skipped: true }).planned.state).toBe('skipped');
    expect(service.updatePlanned(L, plannedId!, { skipped: false }).planned.state).toBe('planned');
    expect(upstream.state.calls).toEqual([]);
  });

  it('skips a failed row', () => {
    const { plannedId } = service.createPlanned(L, { templateId: template.id, localDate: '2026-10-24' });
    setState(plannedId!, 'failed');
    expect(service.updatePlanned(L, plannedId!, { skipped: true }).planned.state).toBe('skipped');
  });

  it.each(['creating', 'created', 'unknown', 'cancelled'])('refuses any change to a %s row', async (state) => {
    const { plannedId } = service.createPlanned(L, { templateId: template.id, localDate: '2026-10-24' });
    setState(plannedId!, state);
    const err = await refusal(() => service.updatePlanned(L, plannedId!, { skipped: true }), 'not_editable');
    expect(err.details).toEqual({ state });
  });

  it('moves the date and time, warning when another row of the template is already there', () => {
    const a = service.createPlanned(L, { templateId: template.id, localDate: '2026-10-24' });
    const b = service.createPlanned(L, { templateId: template.id, localDate: '2026-10-31', startTime: '13:00' });
    const moved = service.updatePlanned(L, b.plannedId!, { localDate: '2026-10-24', startTime: '18:00' });
    expect(moved).toEqual({ planned: expect.objectContaining({ localDate: '2026-10-24', startTime: '18:00' }), warnings: ['another_planned_at_time'] });
    expect(service.updatePlanned(L, a.plannedId!, { localDate: '2026-10-25' }).warnings).toEqual([]);
  });

  it('refuses a move out of the window', async () => {
    const { plannedId } = service.createPlanned(L, { templateId: template.id, localDate: '2026-10-24' });
    await refusal(() => service.updatePlanned(L, plannedId!, { localDate: '2026-09-14' }), 'date_too_far_past');
  });

  it('sets and clears the series pick', () => {
    const { plannedId } = service.createPlanned(L, { templateId: template.id, localDate: '2026-10-24' });
    service.updatePlanned(L, plannedId!, { seriesId: 'custom' });
    const pick = () => database.sqlite.prepare('select series_override s from planned_tournament where id = ?').get(plannedId) as { s: string | null };
    expect(pick().s).toBe('custom');
    service.updatePlanned(L, plannedId!, { seriesId: null });
    expect(pick().s).toBeNull();
  });

  it('is not_found for another league’s row', async () => {
    const { plannedId } = service.createPlanned(L, { templateId: template.id, localDate: '2026-10-24' });
    await refusal(() => service.updatePlanned('other', plannedId!, { skipped: true }), 'not_found');
  });
});
