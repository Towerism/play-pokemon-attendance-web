import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import { TournamentsError } from './errors';
import { type TournamentsService, createTournamentsService } from './service';
import { BROCK, stubPlayTools, templateBody } from './test-helpers';
import { OWNER, professorActor } from '../pokemon/test-helpers';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const TZ = 'America/Chicago';
/** Wednesday 2026-10-14, noon in Chicago. The creatable window starts Monday the 12th. */
const NOON_WED = new Date('2026-10-14T17:00:00Z');

let database: OpenDatabase;
let upstream: ReturnType<typeof stubPlayTools>;
let service: TournamentsService;
let now: Date;

beforeEach(() => {
  database = openDatabase(':memory:');
  migrateDatabase(database.db, MIGRATIONS_DIR);
  database.sqlite.prepare("insert into league (id, name) values ('other', 'Other league')").run();
  upstream = stubPlayTools();
  now = NOON_WED;
  service = createTournamentsService({
    db: database.db,
    connections: upstream.connections,
    gateway: upstream.gateway,
    timeZone: TZ,
    now: () => now,
  });
});
afterEach(() => database.close());

/** Rejects with a TournamentsError of this code. */
async function refusal(promise: Promise<unknown> | (() => unknown), code: string) {
  const run = typeof promise === 'function' ? Promise.resolve().then(promise) : promise;
  const err = await run.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(TournamentsError);
  expect((err as TournamentsError).code).toBe(code);
  return err as TournamentsError;
}

describe('templates', () => {
  it('creates a template, keeping every setting', () => {
    const body = templateBody({ contactPhone: '555-0100', details: 'Bring a deck.' });
    const template = service.createTemplate(L, body, OWNER);
    expect(template).toEqual({ id: expect.any(Number), archived: false, ...body });
    expect(service.listTemplates(L, {})).toEqual([template]);
  });

  it('keeps leagues apart: another league sees none, and can’t change or archive one', async () => {
    const template = service.createTemplate(L, templateBody(), OWNER);
    expect(service.listTemplates('other', {})).toEqual([]);
    await refusal(() => service.updateTemplate('other', template.id, { details: 'x' }, OWNER), 'not_found');
    await refusal(() => service.archiveTemplate('other', template.id, OWNER), 'not_found');
  });

  it('refuses an organizer who isn’t a connected professor, and takes one who needs a reconnect', async () => {
    await refusal(() => service.createTemplate(L, templateBody({ organizerPlayerId: '1234567' as never }), OWNER), 'organizer_not_connected');
    upstream.state.professors.push({ ...BROCK, status: 'needs_reconnect' });
    const template = service.createTemplate(L, templateBody({ organizerPlayerId: BROCK.professorPlayerId as never }), OWNER);
    await refusal(() => service.updateTemplate(L, template.id, { organizerPlayerId: '1234567' as never }, OWNER), 'organizer_not_connected');
  });

  it('patches only the fields sent', () => {
    const template = service.createTemplate(L, templateBody(), OWNER);
    expect(service.updateTemplate(L, template.id, { details: 'Doors at 5.' }, OWNER)).toEqual({ ...template, details: 'Doors at 5.' });
  });

  it('refuses a patch that leaves no contact', async () => {
    const template = service.createTemplate(L, templateBody(), OWNER);
    await refusal(() => service.updateTemplate(L, template.id, { contactEmail: null }, OWNER), 'contact_required');
  });

  it('archives a template no live scaffold uses, listing it only on request', async () => {
    const template = service.createTemplate(L, templateBody(), OWNER);
    const scaffold = service.createScaffold(L, { name: 'Tuesday', slots: [{ templateId: template.id, dayOffset: 0, startTime: null }] });
    const err = await refusal(() => service.archiveTemplate(L, template.id, OWNER), 'template_in_use');
    expect(err.details).toEqual({ scaffoldIds: [scaffold.id] });

    service.archiveScaffold(L, scaffold.id);
    service.archiveTemplate(L, template.id, OWNER);
    expect(service.listTemplates(L, {})).toEqual([]);
    expect(service.listTemplates(L, { archived: true })).toEqual([{ ...template, archived: true }]);
  });

  it('lists by name', () => {
    service.createTemplate(L, templateBody({ name: 'VGC Cup' }), OWNER);
    service.createTemplate(L, templateBody({ name: 'League Challenge' }), OWNER);
    expect(service.listTemplates(L, {}).map((t) => t.name)).toEqual(['League Challenge', 'VGC Cup']);
  });
});

describe('scaffolds', () => {
  it('numbers slots from 0 in the order given', () => {
    const tcg = service.createTemplate(L, templateBody({ name: 'TCG Cup' }), OWNER);
    const vgc = service.createTemplate(L, templateBody({ name: 'VGC Cup', product: 'vg', category: 'vg_mod' }), OWNER);
    const scaffold = service.createScaffold(L, {
      name: 'Saturday Cups',
      slots: [
        { templateId: tcg.id, dayOffset: 0, startTime: null },
        { templateId: vgc.id, dayOffset: 1, startTime: '16:00' },
      ],
    });
    expect(scaffold).toEqual({
      id: expect.any(Number),
      name: 'Saturday Cups',
      archived: false,
      slots: [
        { position: 0, templateId: tcg.id, dayOffset: 0, startTime: null },
        { position: 1, templateId: vgc.id, dayOffset: 1, startTime: '16:00' },
      ],
    });
  });

  it('refuses an archived, unknown or other league’s template', async () => {
    const archived = service.createTemplate(L, templateBody(), OWNER);
    service.archiveTemplate(L, archived.id, OWNER);
    const slot = (templateId: number) => ({ name: 'x', slots: [{ templateId, dayOffset: 0, startTime: null }] });
    await refusal(() => service.createScaffold(L, slot(archived.id)), 'template_archived');
    await refusal(() => service.createScaffold(L, slot(9999)), 'unknown_template');
    await refusal(() => service.createScaffold('other', slot(archived.id)), 'unknown_template');
  });

  it('replaces the slot list and renames on a patch', () => {
    const t = service.createTemplate(L, templateBody(), OWNER);
    const scaffold = service.createScaffold(L, { name: 'Old', slots: [{ templateId: t.id, dayOffset: 0, startTime: null }] });
    const patched = service.updateScaffold(L, scaffold.id, { slots: [{ templateId: t.id, dayOffset: 2, startTime: '13:00' }] });
    expect(patched).toMatchObject({ name: 'Old', slots: [{ position: 0, dayOffset: 2, startTime: '13:00' }] });
    expect(service.updateScaffold(L, scaffold.id, { name: 'New' }).slots).toEqual(patched.slots);
  });

  it('won’t archive a scaffold a live schedule uses', async () => {
    const t = service.createTemplate(L, templateBody(), OWNER);
    const scaffold = service.createScaffold(L, { name: 'Tuesday', slots: [{ templateId: t.id, dayOffset: 0, startTime: null }] });
    const schedule = service.createSchedule(L, { scaffoldId: scaffold.id, rule: { kind: 'weekly', weekday: 2, every: 1 }, startsOn: '2026-10-01', endsOn: null });
    const err = await refusal(() => service.archiveScaffold(L, scaffold.id), 'scaffold_in_use');
    expect(err.details).toEqual({ scheduleIds: [schedule.id] });
    service.archiveSchedule(L, schedule.id);
    service.archiveScaffold(L, scaffold.id);
    expect(service.listScaffolds(L, {})).toEqual([]);
    expect(service.listScaffolds(L, { archived: true })).toHaveLength(1);
  });
});

describe('schedules', () => {
  function scaffoldOf(slots: { dayOffset?: number; startTime?: string | null }[] = [{}]) {
    const t = service.createTemplate(L, templateBody({ startTime: '18:00' }), OWNER);
    return service.createScaffold(L, { name: 'Scaffold', slots: slots.map((s) => ({ templateId: t.id, dayOffset: 0, startTime: null, ...s })) });
  }

  it.each([
    [{ kind: 'weekly', weekday: 2, every: 1 }, 8],
    [{ kind: 'monthly', nth: 3, weekday: 2 }, 13],
    [{ kind: 'quarterly', month: 1, nth: 1, weekday: 6 }, 26],
  ] as const)('defaults the horizon for %j to %i weeks', (rule, weeks) => {
    const schedule = service.createSchedule(L, { scaffoldId: scaffoldOf().id, rule, startsOn: '2026-10-01', endsOn: null });
    expect(schedule).toMatchObject({ horizonWeeks: weeks, paused: false, archived: false, createdThrough: null, scaffoldName: 'Scaffold' });
  });

  it('keeps a horizon given, and lists the league’s schedules', () => {
    const schedule = service.createSchedule(L, { scaffoldId: scaffoldOf().id, rule: { kind: 'monthly', day: 3 }, startsOn: '2026-10-01', endsOn: '2027-06-30', horizonWeeks: 20 });
    expect(schedule.horizonWeeks).toBe(20);
    expect(service.listSchedules(L)).toEqual([schedule]);
    expect(service.listSchedules('other')).toEqual([]);
  });

  it('refuses an unknown or archived scaffold', async () => {
    const scaffold = scaffoldOf();
    service.archiveScaffold(L, scaffold.id);
    const body = (scaffoldId: number) => ({ scaffoldId, rule: { kind: 'monthly' as const, day: 3 }, startsOn: '2026-10-01', endsOn: null });
    await refusal(() => service.createSchedule(L, body(scaffold.id)), 'scaffold_archived');
    await refusal(() => service.createSchedule(L, body(9999)), 'unknown_scaffold');
  });

  it('patches the rule and dates, refusing a last date before the stored first one', async () => {
    const schedule = service.createSchedule(L, { scaffoldId: scaffoldOf().id, rule: { kind: 'monthly', day: 3 }, startsOn: '2026-10-01', endsOn: null });
    expect(service.updateSchedule(L, schedule.id, { paused: true })).toMatchObject({ paused: true });
    await refusal(() => service.updateSchedule(L, schedule.id, { endsOn: '2026-09-01' }), 'invalid_range');
  });

  it('previews the next dates from the window start with each slot, saving nothing', () => {
    const scaffold = scaffoldOf([{}, { dayOffset: 1, startTime: '16:00' }]);
    // 3rd Tuesday monthly, starting long ago: the first date on or after Mon Oct 12 is Tue Oct 20.
    const preview = service.previewSchedule(L, { rule: { kind: 'monthly', nth: 3, weekday: 2 }, startsOn: '2025-01-01', endsOn: null, scaffoldId: scaffold.id, count: 10 });
    expect(preview.dates).toHaveLength(10);
    expect(preview.dates[0]).toEqual({
      occurrenceDate: '2026-10-20',
      slots: [
        { position: 0, localDate: '2026-10-20', startTime: '18:00', startsAt: '2026-10-20T23:00:00.000Z' },
        { position: 1, localDate: '2026-10-21', startTime: '16:00', startsAt: '2026-10-21T21:00:00.000Z' },
      ],
    });
    expect(preview.dates.at(-1)!.occurrenceDate).toBe('2027-07-20');
    expect(service.listSchedules(L)).toEqual([]);
    expect(database.sqlite.prepare('select count(*) n from planned_tournament').get()).toEqual({ n: 0 });
  });

  it('previews dates alone without a scaffold, and marks a start a DST change skips', () => {
    expect(service.previewSchedule(L, { rule: { kind: 'monthly', day: 1 }, startsOn: '2026-10-01', endsOn: null, count: 2 }).dates).toEqual([
      { occurrenceDate: '2026-11-01', slots: [] },
      { occurrenceDate: '2026-12-01', slots: [] },
    ]);
    // 02:30 on Sunday 2027-03-14 doesn't exist in Chicago.
    const scaffold = scaffoldOf([{ startTime: '02:30' }]);
    const [first] = service.previewSchedule(L, { rule: { kind: 'weekly', weekday: 7, every: 1 }, startsOn: '2027-03-14', endsOn: null, scaffoldId: scaffold.id, count: 1 }).dates;
    expect(first!.slots[0]).toEqual({ position: 0, localDate: '2027-03-14', startTime: '02:30', startsAt: null, timeProblem: 'nonexistent' });
  });
});

describe('who may change a template or its planned tournaments (ADR-0015 §4)', () => {
  const MISTY = professorActor(2, 'misty');
  const brocks = () => templateBody({ organizerPlayerId: BROCK.professorPlayerId as never });

  beforeEach(() => upstream.state.professors.push({ ...BROCK, userId: MISTY.userId }));

  it("lets each user name only their own connection as a template's organizer", async () => {
    await refusal(() => service.createTemplate(L, brocks(), OWNER), 'not_your_connection');
    await refusal(() => service.createTemplate(L, templateBody(), MISTY), 'not_your_connection');
    expect(service.createTemplate(L, brocks(), MISTY).organizerPlayerId).toBe(BROCK.professorPlayerId);
  });

  it("refuses the owner editing or archiving a professor's template, and moving their own to a professor", async () => {
    const mine = service.createTemplate(L, templateBody(), OWNER);
    const theirs = service.createTemplate(L, brocks(), MISTY);

    await refusal(() => service.updateTemplate(L, mine.id, { organizerPlayerId: BROCK.professorPlayerId as never }, OWNER), 'not_your_connection');
    const err = await refusal(() => service.updateTemplate(L, theirs.id, { details: 'x' }, OWNER), 'not_your_connection');
    expect(err.details).toMatchObject({ professorPlayerId: BROCK.professorPlayerId });
    await refusal(() => service.archiveTemplate(L, theirs.id, OWNER), 'not_your_connection');
    expect(service.updateTemplate(L, theirs.id, { details: 'Bring dice.' }, MISTY).details).toBe('Bring dice.');
  });

  it("refuses the owner skipping or moving a professor's planned tournament", async () => {
    const theirs = service.createTemplate(L, brocks(), MISTY);
    const { plannedId } = service.createPlanned(L, { templateId: theirs.id, localDate: '2026-11-06' });

    await refusal(() => service.updatePlanned(L, plannedId!, { skipped: true }, OWNER), 'not_your_connection');
    expect(service.updatePlanned(L, plannedId!, { skipped: true }, MISTY).planned.state).toBe('skipped');
  });

  it('lets the owner, and only the owner, tidy up a template whose organizer nobody has connected', async () => {
    const theirs = service.createTemplate(L, brocks(), MISTY);
    upstream.state.professors = upstream.state.professors.filter((p) => p.id !== BROCK.id);

    await refusal(() => service.updateTemplate(L, theirs.id, { details: 'x' }, MISTY), 'organizer_not_connected');
    expect(service.updateTemplate(L, theirs.id, { details: 'Stale.' }, OWNER).details).toBe('Stale.');
    service.archiveTemplate(L, theirs.id, OWNER);
  });
});

