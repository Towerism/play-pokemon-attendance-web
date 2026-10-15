import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApplyBody, EditBody } from '../../../shared/schemas/tournaments';
import { localInstant } from '../../../shared/time/local-time';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import type { TournamentDetails } from '../pokemon/ports/play-tools-gateway';
import { type TournamentsService, createTournamentsService } from './service';
import { BROCK, OLIVE, VENUE, series, stubPlayTools, templateBody, upstreamTournament } from './test-helpers';

// The tournaments module's side of Edit… (#93, ADR-0010 decisions 8 and 11): the form, the preview across a
// schedule, the local writes, and each job item's fresh read. The job itself is the submission module's.

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const TZ = 'America/Chicago';
/** Wednesday 2026-10-14, noon in Chicago: the creatable window starts on the 12th. */
const NOON_WED = new Date('2026-10-14T17:00:00Z');
const LIBRARY = { id: '00000000-0000-4000-8000-000000000052', label: 'Library', timeZone: TZ, country: 'US' };
const TUESDAYS = { kind: 'weekly', weekday: 2, every: 1 } as const;
const guid = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;

let database: OpenDatabase;
let upstream: ReturnType<typeof stubPlayTools>;
let service: TournamentsService;
let moved: { tournamentId: string; to: string }[];
let now: Date;

beforeEach(() => {
  database = openDatabase(':memory:');
  migrateDatabase(database.db, MIGRATIONS_DIR);
  upstream = stubPlayTools();
  upstream.state.professors.push({ ...BROCK });
  upstream.state.venues.push({ id: LIBRARY.id, name: 'Library', formattedAddress: null, country: 'US', timeZone: TZ });
  moved = [];
  now = NOON_WED;
  service = createTournamentsService({
    db: database.db,
    connections: upstream.connections,
    gateway: upstream.gateway,
    staffing: { moveTournament: (_l, tournamentId, to) => (moved.push({ tournamentId, to }), 1), cancelTournament: () => ({ dropped: 0, removed: 0 }) },
    timeZone: TZ,
    now: () => now,
  });
});
afterEach(() => database.close());

type Row = { id: number; state: string; local_date: string; start_time: string; overrides: string; tournament_id: string | null; occurrence_date: string | null; slot_position: number | null };
const rowOf = (id: number) => database.sqlite.prepare('select * from planned_tournament where id = ?').get(id) as Row;
const rowsOf = (scheduleId: number) =>
  database.sqlite.prepare('select * from planned_tournament where schedule_id = ? order by occurrence_date, slot_position').all(scheduleId) as Row[];
const setRow = (id: number, set: string) => database.sqlite.prepare(`update planned_tournament set ${set} where id = ?`).run(id);
const reads = () => upstream.state.calls.filter((c) => c.startsWith('getTournament'));

/** Full details of the stored tournament, as a fresh read returns them. */
const fullDetails = (startsAt: Date): Partial<TournamentDetails> => ({
  venue: { id: VENUE.id, timeZone: TZ },
  contact: { email: 'league@example.com', phone: null },
  registration: { startsAt: new Date(startsAt.getTime() - 60 * 60_000), endsAt: new Date(startsAt.getTime() + 15 * 60_000) },
  details: 'Bring a deck.',
});

/** Puts a row in play-tools: created, linked to a tournament the stub holds at the row's start. */
function inPlayTools(id: number, n: number, opts: Parameters<typeof upstreamTournament>[2] = {}) {
  const row = rowOf(id);
  const startsAt = localInstant(row.local_date, row.start_time, TZ);
  upstream.state.tournaments.push(upstreamTournament(guid(n), startsAt.toISOString(), { name: `Tuesday Cup`, details: fullDetails(startsAt), ...opts }));
  setRow(id, `state = 'created', tournament_id = '${guid(n)}'`);
  return guid(n);
}

function customTemplate(overrides: Parameters<typeof templateBody>[0] = {}) {
  return service.createTemplate(L, templateBody({ name: 'Tuesday Cup', type: { kind: 'custom' }, details: 'Bring a deck.', ...overrides }));
}

/** A weekly Tuesday schedule of one template (two with `sibling`), planned on read. */
async function weekly(opts: { sibling?: boolean } = {}) {
  const t = customTemplate();
  const t2 = opts.sibling ? customTemplate({ name: 'Tuesday VGC', product: 'vg', category: 'vg_std' }) : undefined;
  const slots = [{ templateId: t.id, dayOffset: 0, startTime: null }, ...(t2 ? [{ templateId: t2.id, dayOffset: 0, startTime: '20:00' }] : [])];
  const scaffold = service.createScaffold(L, { name: 'Tuesdays', slots });
  const schedule = service.createSchedule(L, { scaffoldId: scaffold.id, rule: TUESDAYS, startsOn: '2026-09-01', endsOn: null, horizonWeeks: 6 });
  await service.upcoming(L, {});
  return { template: t, sibling: t2, scaffold, schedule, rows: rowsOf(schedule.id) };
}

const body = (changes: Record<string, unknown>, extra: Record<string, unknown> = {}) => EditBody.parse({ changes, ...extra });
const planned = (id: number) => ({ kind: 'planned' as const, id });
const tournament = (id: string) => ({ kind: 'tournament' as const, id });

describe('the edit form', () => {
  it('reads a tournament in play-tools fresh as its organizer, the same by planned id or guid', async () => {
    const { rows } = await weekly();
    const id = inPlayTools(rows[1]!.id, 1); // Tue 2026-10-20

    const byRow = await service.editForm(L, planned(rows[1]!.id));
    const byGuid = await service.editForm(L, tournament(id));

    expect(byGuid).toEqual(byRow);
    expect(byRow).toMatchObject({
      target: { plannedId: rows[1]!.id, tournamentId: id, displayId: `26-10-${id}`, inPlayTools: true },
      values: {
        name: 'Tuesday Cup',
        category: 'tcg_std',
        venue: { id: VENUE.id, label: 'Card Shop', timeZone: TZ, country: 'US' },
        localDate: '2026-10-20',
        startTime: '18:00',
        registration: { kind: 'on_site', opensBeforeMin: 60, closesAfterMin: 15, admission: null },
        contactEmail: 'league@example.com',
        details: 'Bring a deck.',
      },
      readOnly: { league: { displayId: 'L5012' }, organizer: { playerId: OLIVE.professorPlayerId }, product: 'tcg', type: { kind: 'custom' } },
      editable: true,
      lockedReason: null,
      reschedule: { opensOn: '2026-10-17', closesOn: '2027-01-18', open: false },
      schedule: { slotPosition: 0, occurrenceDate: '2026-10-20', scaffoldName: 'Tuesdays', siblings: 0 },
    });
    expect(upstream.state.calls.filter((c) => c.startsWith('getTournament'))).toEqual(['getTournament@1', 'getTournament@1']);
  });

  it('shows a planned row from its resolved settings, with no upstream call', async () => {
    const { rows, template } = await weekly();
    setRow(rows[2]!.id, `overrides = '${JSON.stringify({ details: 'Row details' })}'`);
    upstream.state.calls.length = 0;

    const form = await service.editForm(L, planned(rows[2]!.id));

    expect(form).toMatchObject({
      target: { plannedId: rows[2]!.id, tournamentId: null, inPlayTools: false },
      values: { name: 'Tuesday Cup', localDate: '2026-10-27', startTime: '18:00', details: 'Row details', venue: VENUE },
      reschedule: null,
      templateId: template.id,
      editable: true,
    });
    expect(upstream.state.calls).toEqual([]);
  });

  it("reads a guid as each professor in turn: Brock's tournament is read as Brock", async () => {
    upstream.state.tournaments.push(upstreamTournament(guid(9), '2026-10-24T17:00:00Z', { organizer: BROCK.professorPlayerId! }));
    upstream.state.failNext.set('getTournament@1', new (await import('../pokemon/ports/errors')).PokemonUpstreamError('not_found', 'no'));

    const form = await service.editForm(L, tournament(guid(9)));

    expect(form.readOnly.organizer.playerId).toBe(BROCK.professorPlayerId);
    expect(form.target.plannedId).toBeNull();
    expect(form.schedule).toBeNull();
    expect(reads()).toEqual(['getTournament@1', 'getTournament@2']);
  });

  it('is not_found for a guid nobody can read, and organizer_not_connected for one whose organizer left', async () => {
    await expect(service.editForm(L, tournament(guid(404)))).rejects.toMatchObject({ code: 'not_found' });
    upstream.state.tournaments.push(upstreamTournament(guid(8), '2026-10-24T17:00:00Z', { organizer: '1234567' }));
    await expect(service.editForm(L, tournament(guid(8)))).rejects.toMatchObject({ code: 'organizer_not_connected' });
  });

  it.each(['creating', 'unknown', 'cancelled'])('refuses a %s row as not_editable', async (state) => {
    const { rows } = await weekly();
    setRow(rows[1]!.id, `state = '${state}'`);
    await expect(service.editForm(L, planned(rows[1]!.id))).rejects.toMatchObject({ code: 'not_editable', details: { state } });
  });

  it.each([
    ['not linked', 'null'],
    ['linked', `'${guid(1)}'`],
  ])('refuses a row skipped while its create may have landed (%s), until it is unskipped (#125)', async (_, tournamentId) => {
    const { rows } = await weekly();
    setRow(rows[1]!.id, `state = 'skipped', skipped_while_unknown = 1, tournament_id = ${tournamentId}`);
    const refused = { code: 'not_editable', details: { state: 'skipped', skippedWhileUnknown: true } };
    await expect(service.editForm(L, planned(rows[1]!.id))).rejects.toMatchObject(refused);
    await expect(service.editPreview(L, planned(rows[1]!.id), body({ details: 'New' }))).rejects.toMatchObject(refused);
    await expect(service.editing.prepare(L, planned(rows[1]!.id), ApplyBody.parse({ changes: { details: 'New' } }))).rejects.toMatchObject(refused);
  });

  it('marks a cancelled or old tournament as locked', async () => {
    const { rows } = await weekly();
    inPlayTools(rows[1]!.id, 1, { applicationState: 'cancelled' });
    expect(await service.editForm(L, planned(rows[1]!.id))).toMatchObject({ editable: false, lockedReason: 'tournament_locked' });
  });
});

describe('the preview: refusals on the tournament itself', () => {
  async function created(opts: Parameters<typeof upstreamTournament>[2] = {}) {
    const { rows } = await weekly();
    return { id: rows[1]!.id, guid: inPlayTools(rows[1]!.id, 1, opts), rows };
  }

  it.each([
    ['tournament_locked', { name: 'X' }, { applicationState: 'cancelled' }],
    ['reschedule_window_not_open', { localDate: '2026-10-22' }, {}],
    ['date_too_far_past', { localDate: '2026-10-11' }, {}],
    ['venue_not_found', { venue: { ...LIBRARY, id: '00000000-0000-4000-8000-000000000099' } }, {}],
    ['contact_required', { contactEmail: null }, {}],
    ['nothing_to_change', { name: 'Tuesday Cup', details: 'Bring a deck.' }, {}],
  ] as const)('%s', async (code, changes, opts) => {
    const { id } = await created(opts as never);
    if (code === 'date_too_far_past') now = new Date('2026-10-18T17:00:00Z'); // the window opened on the 17th
    await expect(service.editPreview(L, planned(id), body(changes))).rejects.toMatchObject({ code });
  });

  it('gives the date the reschedule window opens', async () => {
    const { id } = await created();
    await expect(service.editPreview(L, planned(id), body({ localDate: '2026-10-22' }))).rejects.toMatchObject({ details: { opensOn: '2026-10-17' } });
  });

  it('lets a start time change on the same date through: it is not a reschedule', async () => {
    const { id } = await created();
    const preview = await service.editPreview(L, planned(id), body({ startTime: '19:00' }));
    expect(preview).toMatchObject({ reschedule: false, inPlayTools: [{ plannedId: id, changes: [{ field: 'startTime', before: '18:00', after: '19:00' }] }] });
  });

  it('refuses a premier date outside its series window, and a format the series lacks', async () => {
    const { id } = await created();
    upstream.state.tournaments[0]!.details!.series = { id: 's-oct', name: 'League Challenge' };
    upstream.state.series = [series('s-oct', 'League Challenge', '2026-10-01', '2026-10-31')];
    now = new Date('2026-10-18T17:00:00Z');
    await expect(service.editPreview(L, planned(id), body({ localDate: '2026-11-03' }))).rejects.toMatchObject({
      code: 'outside_series_window',
      details: { window: { from: '2026-10-01', to: '2026-10-31' } },
    });
    await expect(service.editPreview(L, planned(id), body({ category: 'tcg_exp' }))).rejects.toMatchObject({ code: 'format_not_in_series' });
    expect((await service.editPreview(L, planned(id), body({ localDate: '2026-10-22' }))).warnings).toContain('may_need_approval');
  });

  it('warns when the series is no longer listed, and leaves the date to play-tools', async () => {
    const { id } = await created();
    upstream.state.tournaments[0]!.details!.series = { id: 's-gone', name: 'League Challenge' };
    now = new Date('2026-10-18T17:00:00Z');
    expect((await service.editPreview(L, planned(id), body({ localDate: '2026-11-03' }))).warnings).toContain('series_window_unknown');
  });

  it('refuses a scope or siblings off a schedule, and a template update with no template', async () => {
    upstream.state.tournaments.push(upstreamTournament(guid(7), '2026-10-24T17:00:00Z'));
    await expect(service.editPreview(L, tournament(guid(7)), body({ name: 'X' }, { scope: 'later' }))).rejects.toMatchObject({ code: 'not_in_schedule' });
    await expect(service.editPreview(L, tournament(guid(7)), body({ name: 'X' }, { withSiblings: true }))).rejects.toMatchObject({ code: 'not_in_schedule' });
    await expect(service.editPreview(L, tournament(guid(7)), body({ name: 'X' }, { updateTemplate: true }))).rejects.toMatchObject({ code: 'no_template' });
  });

  it('says a reschedule into the next 7 days is short notice', async () => {
    const { id } = await created();
    now = new Date('2026-10-18T17:00:00Z');
    expect(await service.editPreview(L, planned(id), body({ localDate: '2026-10-22' }))).toMatchObject({ reschedule: true, shortNotice: true });
  });

  it('warns another planned tournament of the template holds the new date and time', async () => {
    const { rows } = await weekly();
    const preview = await service.editPreview(L, planned(rows[1]!.id), body({ localDate: '2026-10-27' }));
    expect(preview.warnings).toEqual(['another_planned_at_time']);
    expect(preview.planned).toEqual([expect.objectContaining({ plannedId: rows[1]!.id })]);
  });
});

describe('the preview across the schedule', () => {
  it('later: play-tools ones to edit, planned ones to update, the rest left out with why', async () => {
    const { rows } = await weekly();
    // 10-13 (before the window? no: the 12th starts it), 10-20 edited, 10-27 and 11-03 in play-tools, 11-10 cancelled.
    const [, edited, a, b, cancelled] = rows;
    inPlayTools(edited!.id, 1);
    inPlayTools(a!.id, 2);
    inPlayTools(b!.id, 3);
    setRow(cancelled!.id, "state = 'cancelled'");

    const preview = await service.editPreview(L, planned(edited!.id), body({ venue: LIBRARY, details: 'Moved to the library.' }, { scope: 'later' }));

    expect(preview.inPlayTools.map((e) => e.plannedId)).toEqual([edited!.id, a!.id, b!.id]);
    expect(preview.inPlayTools[1]!.changes).toEqual([
      { field: 'venue', before: { id: VENUE.id, label: 'Card Shop', timeZone: TZ, country: 'US' }, after: LIBRARY },
      { field: 'details', before: 'Bring a deck.', after: 'Moved to the library.' },
    ]);
    expect(preview.planned.map((e) => e.plannedId)).toEqual(rows.slice(5).map((r) => r.id));
    expect(preview.leftOut).toEqual([{ entry: expect.objectContaining({ plannedId: cancelled!.id }), reason: 'cancelled' }]);
    expect(preview.count).toBe(3);
  });

  it('leaves out a play-tools one that is locked, unreadable, or already has the change', async () => {
    const { rows } = await weekly();
    inPlayTools(rows[1]!.id, 1);
    inPlayTools(rows[2]!.id, 2, { applicationState: 'cancelled' });
    inPlayTools(rows[3]!.id, 3);
    const same = inPlayTools(rows[4]!.id, 4);
    upstream.state.tournaments.find((t) => t.id === same)!.details!.details = 'New';
    upstream.state.tournaments = upstream.state.tournaments.filter((t) => t.id !== guid(3));

    const preview = await service.editPreview(L, planned(rows[1]!.id), body({ details: 'New' }, { scope: 'later' }));

    expect(preview.leftOut.map((l) => [l.entry.plannedId, l.reason, l.code])).toEqual([
      [rows[2]!.id, 'tournament_locked', undefined],
      [rows[3]!.id, 'unreadable', 'not_found'],
      [rows[4]!.id, 'no_change', undefined],
    ]);
  });

  it('carries only the ticked fields, and siblings only what fits across slots', async () => {
    const { rows } = await weekly({ sibling: true });
    const slot0 = rows.filter((r) => r.slot_position === 0);
    const slot1 = rows.filter((r) => r.slot_position === 1);

    const preview = await service.editPreview(L, planned(slot0[1]!.id), body({ name: 'Halloween Cup', details: 'Costumes' }, { scope: 'later', withSiblings: true }));

    const changed = (id: number) => [...preview.planned, ...preview.inPlayTools].find((e) => e.plannedId === id)!.changes.map((c) => c.field);
    expect(changed(slot0[1]!.id)).toEqual(['name', 'details']);
    expect(changed(slot0[2]!.id)).toEqual(['details']);
    expect(changed(slot1[1]!.id)).toEqual(['details']);
    expect(preview.planned.find((e) => e.plannedId === slot1[1]!.id)!.sibling).toBe(true);
  });

  it('refuses more than 60 play-tools tournaments before reading them', async () => {
    const { schedule } = await weekly({ sibling: true });
    await service.createThrough(L, schedule.id, '2027-10-13');
    const all = rowsOf(schedule.id).filter((r) => r.local_date >= '2026-10-20');
    all.slice(0, 61).forEach((r, i) => setRow(r.id, `state = 'created', tournament_id = '${guid(100 + i)}'`));
    upstream.state.tournaments.push(upstreamTournament(guid(100), '2026-10-20T23:00:00Z', { name: 'Tuesday Cup', details: fullDetails(new Date('2026-10-20T23:00:00Z')) }));
    upstream.state.calls.length = 0;

    await expect(service.editPreview(L, planned(all[0]!.id), body({ details: 'X' }, { scope: 'later', withSiblings: true }))).rejects.toMatchObject({
      code: 'too_many_tournaments',
      details: { count: 61 },
    });
    expect(reads().length).toBeLessThanOrEqual(1);
  });
});

describe('Update the template', () => {
  it('lists the schedules using it and the overrides that would still win', async () => {
    const { rows, template, schedule } = await weekly();
    setRow(rows[3]!.id, `overrides = '${JSON.stringify({ details: 'Keep this' })}'`);

    const preview = await service.editPreview(L, planned(rows[1]!.id), body({ details: 'New' }, { updateTemplate: true }));

    expect(preview.template).toEqual({
      templateId: template.id,
      schedules: [{ scheduleId: schedule.id, scaffoldName: 'Tuesdays' }],
      shadowedBy: [{ source: 'rows', scheduleId: schedule.id, slotPosition: null, from: '2026-11-03', to: '2026-11-03', fields: ['details'], plannedIds: [rows[3]!.id] }],
    });
  });
});

describe('applying locally', () => {
  const apply = async (target: ReturnType<typeof planned>, raw: Record<string, unknown>) => {
    const plan = await service.editing.prepare(L, target, ApplyBody.parse(raw));
    return { plan, updated: database.db.transaction(() => service.editing.applyLocal(L, plan, 'organizer')) };
  };

  it('later: overrides on the planned rows, a schedule override from the edited date, one item per play-tools tournament', async () => {
    const { rows, schedule } = await weekly();
    inPlayTools(rows[1]!.id, 1);
    inPlayTools(rows[2]!.id, 2);

    const { plan, updated } = await apply(planned(rows[1]!.id), { changes: { venue: LIBRARY, name: 'Library Cup' }, scope: 'later' });

    expect(plan.items.map((i) => [i.plannedId, i.tournamentId, i.changes])).toEqual([
      [rows[1]!.id, guid(1), { venue: LIBRARY, name: 'Library Cup' }],
      [rows[2]!.id, guid(2), { venue: LIBRARY }],
    ]);
    expect(plan.items[0]).toMatchObject({ label: 'Tuesday Cup · 2026-10-20', professorPlayerId: OLIVE.professorPlayerId, shortNotice: false });
    expect(updated).toBe(rows.length - 3);
    expect(JSON.parse(rowOf(rows[3]!.id).overrides)).toEqual({ venue: LIBRARY });
    expect(database.sqlite.prepare('select slot_position, effective_from, fields from tournament_schedule_override').all()).toEqual([
      { slot_position: 0, effective_from: '2026-10-20', fields: JSON.stringify({ venue: LIBRARY }) },
    ]);
    // A date planned later is created with the new venue.
    await service.createThrough(L, schedule.id, '2027-01-26');
    const later = (await service.upcoming(L, { from: '2027-01-26', to: '2027-01-26' })).tournaments[0]!;
    expect((await service.editForm(L, planned(later.plannedId!))).values.venue).toEqual(LIBRARY);
  });

  it('leaves excluded rows as they were, pinned against the schedule override', async () => {
    const { rows } = await weekly();
    inPlayTools(rows[1]!.id, 1);
    inPlayTools(rows[2]!.id, 2);

    const { plan } = await apply(planned(rows[1]!.id), { changes: { venue: LIBRARY }, scope: 'later', excluded: [`p:${rows[2]!.id}`, `p:${rows[3]!.id}`] });

    expect(plan.items.map((i) => i.plannedId)).toEqual([rows[1]!.id]);
    expect((await service.editForm(L, planned(rows[3]!.id))).values.venue).toEqual(VENUE);
    expect((await service.editForm(L, planned(rows[4]!.id))).values.venue).toEqual(LIBRARY);
  });

  it('leaves a row skipped while its create may have landed out, as it was (#125)', async () => {
    const { rows } = await weekly();
    const held = rows[3]!.id;
    setRow(held, "state = 'skipped', skipped_while_unknown = 1");

    const preview = await service.editPreview(L, planned(rows[1]!.id), body({ venue: LIBRARY }, { scope: 'later' }));
    expect(preview.leftOut).toEqual([{ entry: expect.objectContaining({ plannedId: held }), reason: 'skipped_while_unknown' }]);
    await apply(planned(rows[1]!.id), { changes: { venue: LIBRARY }, scope: 'later' });

    setRow(held, "state = 'planned', skipped_while_unknown = 0");
    expect((await service.editForm(L, planned(held))).values.venue).toEqual(VENUE);
    expect((await service.editForm(L, planned(rows[4]!.id))).values.venue).toEqual(LIBRARY);
  });

  it('moves a planned row and sets its date as an override', async () => {
    const { rows } = await weekly();
    await apply(planned(rows[2]!.id), { changes: { localDate: '2026-10-29', startTime: '17:00' } });
    expect(rowOf(rows[2]!.id)).toMatchObject({ local_date: '2026-10-29', start_time: '17:00' });
    expect(JSON.parse(rowOf(rows[2]!.id).overrides)).toEqual({ localDate: '2026-10-29', startTime: '17:00' });
  });

  it('updates the template, clearing shadows only when asked', async () => {
    const { rows, template } = await weekly();
    setRow(rows[3]!.id, `overrides = '${JSON.stringify({ details: 'Keep this', startTime: '17:00' })}'`);

    await apply(planned(rows[1]!.id), { changes: { details: 'New' }, updateTemplate: true });
    expect(service.listTemplates(L, {}).find((t) => t.id === template.id)!.details).toBe('New');
    expect(JSON.parse(rowOf(rows[3]!.id).overrides)).toEqual({ details: 'Keep this', startTime: '17:00' });

    await apply(planned(rows[1]!.id), { changes: { details: 'Newer' }, updateTemplate: true, clearShadowingOverrides: true });
    expect(JSON.parse(rowOf(rows[3]!.id).overrides)).toEqual({ startTime: '17:00' });
  });

  it('lists a one-off’s own details among the overrides that would still win, and clears them only when asked (#162)', async () => {
    const { rows, template } = await weekly();
    const oneOff = service.createPlanned(L, { templateId: template.id, localDate: '2026-10-30', overrides: { details: 'Costumes welcome' } }).plannedId!;

    const preview = await service.editPreview(L, planned(rows[1]!.id), body({ details: 'New' }, { updateTemplate: true }));
    expect(preview.template!.shadowedBy.flatMap((s) => s.plannedIds)).toContain(oneOff);

    await apply(planned(rows[1]!.id), { changes: { details: 'New' }, updateTemplate: true });
    expect(JSON.parse(rowOf(oneOff).overrides)).toEqual({ details: 'Costumes welcome' });

    await apply(planned(rows[1]!.id), { changes: { details: 'Newer' }, updateTemplate: true, clearShadowingOverrides: true });
    expect(JSON.parse(rowOf(oneOff).overrides)).toEqual({});
  });

  it('refuses a short-notice reschedule in play-tools without the acknowledgement, writing nothing', async () => {
    const { rows } = await weekly();
    inPlayTools(rows[1]!.id, 1);
    now = new Date('2026-10-18T17:00:00Z');
    await expect(service.editing.prepare(L, planned(rows[1]!.id), ApplyBody.parse({ changes: { localDate: '2026-10-22' } }))).rejects.toMatchObject({
      code: 'short_notice_not_acknowledged',
    });
    const plan = await service.editing.prepare(L, planned(rows[1]!.id), ApplyBody.parse({ changes: { localDate: '2026-10-22' }, acknowledgeShortNotice: true }));
    expect(plan).toMatchObject({ reschedule: true, label: 'Reschedule Tuesday Cup · 2026-10-20', items: [{ shortNotice: true }] });
  });

  it('refuses an apply with everything excluded', async () => {
    const { rows } = await weekly();
    await expect(service.editing.prepare(L, planned(rows[1]!.id), ApplyBody.parse({ changes: { details: 'X' }, excluded: [`p:${rows[1]!.id}`] }))).rejects.toMatchObject({
      code: 'nothing_to_edit',
    });
  });
});

describe("a job item's turn", () => {
  async function item(changes: Record<string, unknown>, at?: Date) {
    const { rows } = await weekly();
    inPlayTools(rows[1]!.id, 1);
    if (at) now = at;
    const plan = await service.editing.prepare(L, planned(rows[1]!.id), ApplyBody.parse({ changes, acknowledgeShortNotice: true }));
    return { row: rows[1]!, item: { ...plan.items[0]!, position: 0 } };
  }

  it('reads fresh and sends only what differs, so a change made meanwhile in play-tools survives', async () => {
    const { item: it_ } = await item({ venue: LIBRARY });
    upstream.state.tournaments[0]!.details!.details = 'Changed in play-tools';

    const read = await service.editing.readItem(L, it_);

    expect(read).toMatchObject({ kind: 'send', connectionId: OLIVE.id, delta: { venueId: LIBRARY.id } });
    expect(Object.keys((read as { delta: object }).delta)).toEqual(['venueId']);
  });

  it('is already_applied when play-tools already holds every change', async () => {
    const { item: it_ } = await item({ details: 'Bring a deck.', venue: LIBRARY });
    upstream.state.tournaments[0]!.details!.venue = { id: LIBRARY.id, timeZone: TZ };
    expect(await service.editing.readItem(L, it_)).toMatchObject({ kind: 'already_applied' });
  });

  it('fails a tournament play-tools no longer has, or locked meanwhile', async () => {
    const { item: it_ } = await item({ details: 'X' });
    upstream.state.tournaments[0]!.applicationState = 'cancelled';
    expect(await service.editing.readItem(L, it_)).toMatchObject({ kind: 'fail', code: 'tournament_locked' });
    upstream.state.tournaments = [];
    expect(await service.editing.readItem(L, it_)).toMatchObject({ kind: 'fail', code: 'unknown_tournament' });
  });

  it('records an edit on the planned row, and moves the staff after a reschedule', async () => {
    const { row, item: it_ } = await item({ localDate: '2026-10-22', details: 'Thursday now' }, new Date('2026-10-18T17:00:00Z'));
    const read = await service.editing.readItem(L, it_);

    service.editing.recordEdited(L, it_, read as never);

    expect(rowOf(row.id)).toMatchObject({ state: 'created', local_date: '2026-10-22' });
    expect(JSON.parse(rowOf(row.id).overrides)).toEqual({ localDate: '2026-10-22', details: 'Thursday now' });
    expect(moved).toEqual([{ tournamentId: guid(1), to: '2026-10-22' }]);
  });
});
