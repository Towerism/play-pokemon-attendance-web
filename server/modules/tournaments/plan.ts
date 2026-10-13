import { occurrenceDates } from '../../../shared/schedule/expand';
import type { ScheduleRule } from '../../../shared/schedule/rule';
import { addDays, type LocalDate } from './dates';

export type PlannedRowState = 'planned' | 'skipped' | 'creating' | 'created' | 'failed' | 'cancelled' | 'unknown';

/** Rows that haven't reached play-tools and no job holds: only these are ever replanned (ADR-0010 decision 4, #100). */
export const REPLANNABLE: ReadonlySet<PlannedRowState> = new Set(['planned', 'skipped', 'failed']);

export interface PlanSlot {
  position: number;
  templateId: number;
  dayOffset: number;
  /** The slot's own start time, else its template's. */
  startTime: string;
}

export interface PlanRow {
  id: number;
  slotPosition: number;
  occurrenceDate: LocalDate;
  templateId: number;
  localDate: LocalDate;
  startTime: string;
  state: PlannedRowState;
  /** A date or time set on the row itself sticks across replans. */
  overrides: { localDate?: LocalDate; startTime?: string };
}

export interface PlanInput {
  schedule: {
    rule: ScheduleRule;
    startsOn: LocalDate;
    endsOn: LocalDate | null;
    horizonWeeks: number;
    /** Not paused, not archived, and its scaffold isn't archived. */
    active: boolean;
  };
  slots: readonly PlanSlot[];
  /** Every row of this schedule. */
  rows: readonly PlanRow[];
  /** In the league time zone. */
  today: LocalDate;
  /** The creatable window's start: rows on earlier scaffold dates are history. */
  windowStart: LocalDate;
  /** `eventKey`s held by rows of other schedules or one-offs that aren't cancelled. */
  takenElsewhere: ReadonlySet<string>;
}

export interface NewRow {
  occurrenceDate: LocalDate;
  slotPosition: number;
  templateId: number;
  localDate: LocalDate;
  startTime: string;
}

export interface Plan {
  insert: NewRow[];
  /** Replannable rows that no longer fit. */
  delete: number[];
  /** Replannable rows that fit but whose slot moved them. */
  update: { id: number; templateId: number; localDate: LocalDate; startTime: string }[];
  /** Rows play-tools has (or a job holds) that no longer fit: kept, shown as no longer in the schedule. */
  notInSchedule: number[];
}

/** One event: a template on a local date at a start time (ADR-0010 decision 4, "one planned row per event"). */
export const eventKey = (templateId: number, localDate: LocalDate, startTime: string) => `${templateId}|${localDate}|${startTime}`;

/**
 * What one schedule's rows should become (ADR-0010 decision 4): every occurrence from the window start to
 * today + horizon gets a row, rows that no longer fit are deleted only when nothing upstream or no job can
 * have them, and rows on scaffold dates before the window start are never touched. Pure.
 */
export function planSchedule(input: PlanInput): Plan {
  const { schedule, windowStart } = input;
  const slots = new Map(input.slots.map((s) => [s.position, s]));
  const bounds = { startsOn: schedule.startsOn, endsOn: schedule.endsOn };
  const fits = (r: PlanRow) =>
    schedule.active && slots.has(r.slotPosition) && occurrenceDates(schedule.rule, bounds, { from: r.occurrenceDate, to: r.occurrenceDate }).length === 1;

  const plan: Plan = { insert: [], delete: [], update: [], notInSchedule: [] };
  const existing = new Set<string>();
  for (const r of input.rows) {
    existing.add(`${r.occurrenceDate}#${r.slotPosition}`);
    if (r.occurrenceDate < windowStart) continue;
    const replannable = REPLANNABLE.has(r.state);
    if (!fits(r)) {
      (replannable ? plan.delete : plan.notInSchedule).push(r.id);
      continue;
    }
    if (!replannable) continue;
    const slot = slots.get(r.slotPosition)!;
    const want = {
      templateId: slot.templateId,
      localDate: r.overrides.localDate ?? addDays(r.occurrenceDate, slot.dayOffset),
      startTime: r.overrides.startTime ?? slot.startTime,
    };
    if (want.templateId !== r.templateId || want.localDate !== r.localDate || want.startTime !== r.startTime) plan.update.push({ id: r.id, ...want });
  }

  if (!schedule.active) return plan;
  const horizonEnd = addDays(input.today, schedule.horizonWeeks * 7);
  if (horizonEnd < windowStart) return plan;
  for (const occurrenceDate of occurrenceDates(schedule.rule, bounds, { from: windowStart, to: horizonEnd })) {
    for (const slot of input.slots) {
      if (existing.has(`${occurrenceDate}#${slot.position}`)) continue;
      const localDate = addDays(occurrenceDate, slot.dayOffset);
      if (input.takenElsewhere.has(eventKey(slot.templateId, localDate, slot.startTime))) continue;
      plan.insert.push({ occurrenceDate, slotPosition: slot.position, templateId: slot.templateId, localDate, startTime: slot.startTime });
    }
  }
  return plan;
}

/** 8 weeks for weekly, 3 months for monthly, 2 quarters for quarterly (ADR-0010 decision 3). */
export function defaultHorizonWeeks(rule: ScheduleRule): number {
  return { weekly: 8, monthly: 13, quarterly: 26 }[rule.kind];
}
