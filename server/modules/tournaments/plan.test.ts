import { describe, expect, it } from 'vitest';
import { defaultHorizonWeeks, eventKey, planSchedule, type PlanInput, type PlannedRowState, type PlanRow } from './plan';

// Wednesday 2026-10-14; the creatable window starts Monday the 12th.
const WINDOW_START = '2026-10-12';
const TODAY = '2026-10-14';

/** Weekly on Tuesdays, two slots: the template 1 cup at 12:00 and template 2 on the next day at 16:00. */
function input(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    schedule: {
      rule: { kind: 'weekly', weekday: 2, every: 1 },
      startsOn: '2026-09-01',
      endsOn: null,
      horizonWeeks: 3,
      active: true,
    },
    slots: [
      { position: 0, templateId: 1, dayOffset: 0, startTime: '12:00' },
      { position: 1, templateId: 2, dayOffset: 1, startTime: '16:00' },
    ],
    rows: [],
    today: TODAY,
    windowStart: WINDOW_START,
    takenElsewhere: new Set(),
    ...overrides,
  };
}

let nextId = 1;
function row(occurrenceDate: string, state: PlannedRowState, opts: Partial<PlanRow> = {}): PlanRow {
  return { id: nextId++, slotPosition: 0, occurrenceDate, templateId: 1, localDate: occurrenceDate, startTime: '12:00', state, overrides: {}, ...opts };
}

const keys = (inserts: { occurrenceDate: string; slotPosition: number }[]) => inserts.map((i) => `${i.occurrenceDate}#${i.slotPosition}`);

describe('materialising a schedule', () => {
  it('plans every slot of every scaffold date from the window start to today + horizon', () => {
    const plan = planSchedule(input());
    // Tuesdays from Oct 12 to Nov 4 (today + 21 days): Oct 13, 20, 27, Nov 3.
    expect(keys(plan.insert)).toEqual(['2026-10-13#0', '2026-10-13#1', '2026-10-20#0', '2026-10-20#1', '2026-10-27#0', '2026-10-27#1', '2026-11-03#0', '2026-11-03#1']);
    expect(plan.insert[1]).toEqual({ occurrenceDate: '2026-10-13', slotPosition: 1, templateId: 2, localDate: '2026-10-14', startTime: '16:00' });
    expect(plan.delete).toEqual([]);
  });

  it('plans past the horizon up to a create-through date (#92), and never short of the horizon', () => {
    expect(keys(planSchedule(input({ through: '2026-11-17' })).insert).filter((k) => k.endsWith('#0'))).toEqual([
      '2026-10-13#0',
      '2026-10-20#0',
      '2026-10-27#0',
      '2026-11-03#0',
      '2026-11-10#0',
      '2026-11-17#0',
    ]);
    expect(planSchedule(input({ through: '2026-10-20' })).insert).toEqual(planSchedule(input()).insert);
  });

  it('adds nothing for an occurrence that already has a row, in any state', () => {
    const states: PlannedRowState[] = ['planned', 'skipped', 'creating', 'created', 'failed', 'cancelled', 'unknown', 'planned'];
    const dates = ['2026-10-13', '2026-10-20', '2026-10-27', '2026-11-03'];
    const rows = states.map((state, i) => row(dates[Math.floor(i / 2)]!, state, { slotPosition: i % 2 }));
    expect(planSchedule(input({ rows })).insert).toEqual([]);
  });

  it('skips an occurrence the same template already holds on that date and time elsewhere (a one-off)', () => {
    const plan = planSchedule(input({ takenElsewhere: new Set([eventKey(2, '2026-10-21', '16:00')]) }));
    expect(keys(plan.insert)).not.toContain('2026-10-20#1');
    expect(keys(plan.insert)).toContain('2026-10-20#0');
  });

  it('keeps two identical slots as two rows', () => {
    const plan = planSchedule(
      input({
        slots: [
          { position: 0, templateId: 1, dayOffset: 0, startTime: '12:00' },
          { position: 1, templateId: 1, dayOffset: 0, startTime: '12:00' },
        ],
      }),
    );
    expect(keys(plan.insert).filter((k) => k.startsWith('2026-10-13'))).toEqual(['2026-10-13#0', '2026-10-13#1']);
  });

  it('plans nothing for an inactive schedule, or one that ended before the window', () => {
    expect(planSchedule(input({ schedule: { ...input().schedule, active: false } })).insert).toEqual([]);
    expect(planSchedule(input({ schedule: { ...input().schedule, endsOn: '2026-10-11' } })).insert).toEqual([]);
  });

  it('stops at the last date and starts at the first', () => {
    const plan = planSchedule(input({ schedule: { ...input().schedule, startsOn: '2026-10-19', endsOn: '2026-10-27' } }));
    expect([...new Set(plan.insert.map((i) => i.occurrenceDate))]).toEqual(['2026-10-20', '2026-10-27']);
  });
});

describe('replanning after an edit', () => {
  // The schedule moves from Tuesdays to Thursdays: none of the Tuesday rows fit any more.
  const thursdays = { ...input().schedule, rule: { kind: 'weekly' as const, weekday: 4 as const, every: 1 as const } };

  it('deletes planned, skipped and failed rows that no longer fit, and keeps every other state', () => {
    const rows = (['planned', 'skipped', 'failed', 'creating', 'unknown', 'created', 'cancelled'] as const).map((s) => row('2026-10-20', s));
    const plan = planSchedule(input({ schedule: thursdays, rows }));
    expect(plan.delete.sort()).toEqual(rows.slice(0, 3).map((r) => r.id).sort());
    expect(plan.notInSchedule.sort()).toEqual(rows.slice(3).map((r) => r.id).sort());
    expect(keys(plan.insert)).toContain('2026-10-15#0');
  });

  it('never touches a row whose scaffold date is before the window start', () => {
    const old = row('2026-10-06', 'planned');
    const plan = planSchedule(input({ schedule: thursdays, rows: [old] }));
    expect(plan.delete).toEqual([]);
    expect(plan.update).toEqual([]);
  });

  it('deletes rows of a slot position the scaffold no longer has', () => {
    const gone = row('2026-10-20', 'skipped', { slotPosition: 1, templateId: 2 });
    const plan = planSchedule(input({ slots: [input().slots[0]!], rows: [gone] }));
    expect(plan.delete).toEqual([gone.id]);
  });

  it('a paused or archived schedule fits nothing', () => {
    const planned = row('2026-10-20', 'planned');
    const created = row('2026-10-27', 'created');
    const plan = planSchedule(input({ schedule: { ...input().schedule, active: false }, rows: [planned, created] }));
    expect(plan.delete).toEqual([planned.id]);
    expect(plan.notInSchedule).toEqual([created.id]);
  });

  it('keeps a fitting skipped row skipped, past the horizon too', () => {
    const skipped = row('2026-12-29', 'skipped');
    const plan = planSchedule(input({ rows: [skipped] }));
    expect(plan.delete).toEqual([]);
    expect(plan.notInSchedule).toEqual([]);
  });

  it('moves a fitting row not yet in play-tools to its slot’s day offset, time and template, unless the row set its own', () => {
    const slots = [{ position: 0, templateId: 3, dayOffset: 1, startTime: '13:00' }];
    const moved = row('2026-10-20', 'failed');
    const ownTime = row('2026-10-27', 'planned', { startTime: '19:00', overrides: { startTime: '19:00' } });
    const ownDate = row('2026-11-03', 'skipped', { localDate: '2026-11-05', overrides: { localDate: '2026-11-05' } });
    const held = row('2026-10-13', 'creating');
    const plan = planSchedule(input({ slots, rows: [moved, ownTime, ownDate, held] }));
    expect(plan.update).toEqual([
      { id: moved.id, templateId: 3, localDate: '2026-10-21', startTime: '13:00' },
      { id: ownTime.id, templateId: 3, localDate: '2026-10-28', startTime: '19:00' },
      { id: ownDate.id, templateId: 3, localDate: '2026-11-05', startTime: '13:00' },
    ]);
  });

  it('keeps a row skipped while its create may have landed: never deleted, never moved, its occurrence not replanned', () => {
    const held = row('2026-10-20', 'skipped', { skippedWhileUnknown: true });
    const linked = row('2026-10-27', 'skipped', { skippedWhileUnknown: true });
    const ordinary = row('2026-11-03', 'skipped');
    const gone = planSchedule(input({ schedule: thursdays, rows: [held, linked, ordinary] }));
    expect(gone.delete).toEqual([ordinary.id]);
    expect(gone.notInSchedule.sort()).toEqual([held.id, linked.id].sort());

    const slots = [{ position: 0, templateId: 3, dayOffset: 1, startTime: '13:00' }];
    const moved = planSchedule(input({ slots, rows: [held] }));
    expect(moved.update).toEqual([]);
    expect(keys(moved.insert)).not.toContain('2026-10-20#0');
  });

  it('reports no update for a row already in step', () => {
    expect(planSchedule(input({ rows: [row('2026-10-20', 'planned')] })).update).toEqual([]);
  });
});

describe('default horizons (ADR-0010 decision 3)', () => {
  it.each([
    [{ kind: 'weekly', weekday: 2, every: 1 }, 8],
    [{ kind: 'monthly', day: 3 }, 13],
    [{ kind: 'monthly', nth: 3, weekday: 2 }, 13],
    [{ kind: 'quarterly', month: 1, nth: 'last', weekday: 6 }, 26],
  ] as const)('%j → %i weeks', (rule, weeks) => {
    expect(defaultHorizonWeeks(rule)).toBe(weeks);
  });
});
