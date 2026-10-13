import { and, asc, eq, gte, inArray, isNull, lte, ne } from 'drizzle-orm';
import { expandSchedule, occurrenceDates } from '../../../shared/schedule/expand';
import type { ScheduleRule } from '../../../shared/schedule/rule';
import type {
  PlannedBody,
  PlannedPatch,
  ScaffoldBody,
  ScaffoldPatch,
  ScheduleBody,
  SchedulePatch,
  SchedulePreviewBody,
  TemplateBody,
  TemplatePatch,
} from '../../../shared/schemas/tournaments';
import { LocalTimeError, dateIn, localInstant } from '../../../shared/time/local-time';
import type { Db } from '../../db/client';
import {
  plannedTournament,
  scaffoldSlot,
  tournamentScaffold,
  tournamentSchedule,
  tournamentScheduleOverride,
  tournamentTemplate,
} from '../../db/schema';
import type { ActingConnection, PokemonConnectionService } from '../pokemon/connection';
import type { PlayToolsGateway, Series } from '../pokemon/ports/play-tools-gateway';
import { addDays, type LocalDate } from './dates';
import { TournamentsError } from './errors';
import { REPLANNABLE, defaultHorizonWeeks, eventKey, fitsSchedule, planSchedule, type PlannedRowState } from './plan';
import { type RegistrationSettings, type SettingsOverrides, type TemplateVenue, resolveSettings } from './settings';
import { type TemplateType, type TypeResolution, resolveSeries } from './series';
import { checkCreatable, creatableWindow, sanctionBy } from './window';

export interface Template {
  id: number;
  name: string;
  organizerPlayerId: string;
  product: 'tcg' | 'vg' | 'pgo';
  category: string;
  type: TemplateType;
  venue: TemplateVenue;
  startTime: string;
  registration: RegistrationSettings;
  contactEmail: string | null;
  contactPhone: string | null;
  details: string | null;
  eventWebsite: string | null;
  archived: boolean;
}

export interface ScaffoldSlotView {
  position: number;
  templateId: number;
  dayOffset: number;
  /** Overrides the template's start time; null uses it. */
  startTime: string | null;
}

export interface Scaffold {
  id: number;
  name: string;
  archived: boolean;
  slots: ScaffoldSlotView[];
}

export interface Schedule {
  id: number;
  scaffoldId: number;
  scaffoldName: string;
  rule: ScheduleRule;
  startsOn: LocalDate;
  endsOn: LocalDate | null;
  horizonWeeks: number;
  paused: boolean;
  archived: boolean;
  /** The last date **Create through date…** covered (#92). */
  createdThrough: LocalDate | null;
}

export interface PreviewSlot {
  position: number;
  localDate: LocalDate;
  startTime: string;
  /** ISO; null when a DST change skips or repeats the time. */
  startsAt: string | null;
  timeProblem?: 'nonexistent' | 'ambiguous';
}

export interface SchedulePreview {
  dates: { occurrenceDate: LocalDate; slots: PreviewSlot[] }[];
}

/** A tournament's organizer, and whether the app can act as them (ADR-0009). */
export interface OrganizerView {
  playerId: string;
  /** Their display name in this app, when they are a connected professor who has one. */
  name: string | null;
  connected: boolean;
  needsReconnect: boolean;
}

export type UpcomingAction = 'create' | 'skip' | 'unskip';

/** One tournament on Upcoming: a planned row (perhaps already in play-tools), or a play-tools one the app didn't plan. */
export interface UpcomingEntry {
  plannedId: number | null;
  /** The upstream guid, once there is one. */
  tournamentId: string | null;
  scheduleId: number | null;
  slotPosition: number | null;
  /** The scaffold's date it was planned for; null for a one-off or a play-tools tournament. */
  occurrenceDate: LocalDate | null;
  templateId: number | null;
  /** With its tokens filled. */
  name: string;
  localDate: LocalDate;
  startTime: string;
  /** ISO; null when a DST change skips or repeats the start. */
  startsAt: string | null;
  timeProblem?: 'nonexistent' | 'ambiguous';
  /** The date − 7 days (a guideline, ADR-0010 decision 6). */
  sanctionBy: LocalDate;
  /** `upstream` for a play-tools tournament no row plans. */
  state: PlannedRowState | 'upstream';
  /** False for a row its schedule no longer plans (kept because play-tools has it or a job holds it); null off a schedule. */
  inSchedule: boolean | null;
  organizer: OrganizerView | null;
  product: string | null;
  category: string | null;
  /** Null when not resolved here: play-tools' own tournaments, and rows already in play-tools. */
  type: TypeResolution | null;
  displayId: string | null;
  upstreamStatus: string | null;
  errorCode: string | null;
  actions: UpcomingAction[];
}

export interface UnreadProfessor {
  professor: { playerId: string | null; name: string | null };
  code: string;
  message: string;
}

export interface Upcoming {
  timeZone: string;
  from: LocalDate;
  to: LocalDate;
  tournaments: UpcomingEntry[];
  /** Whether play-tools' tournaments were read, or why not. */
  upstream: 'read' | 'not_connected' | 'league_not_selected';
  /** Professors whose tournaments couldn't be read; everyone else's still show. */
  unread: UnreadProfessor[];
}

export interface TournamentsService {
  /** The league's templates by name; archived ones only when asked. */
  listTemplates(leagueId: string, opts: { archived?: boolean }): Template[];
  /** @throws TournamentsError `organizer_not_connected` */
  createTemplate(leagueId: string, body: TemplateBody): Template;
  /** Changes only the fields given. @throws TournamentsError `not_found`, `organizer_not_connected`, `contact_required` */
  updateTemplate(leagueId: string, id: number, patch: TemplatePatch): Template;
  /** Archives; never deletes. @throws TournamentsError `not_found`, `template_in_use` */
  archiveTemplate(leagueId: string, id: number): void;

  listScaffolds(leagueId: string, opts: { archived?: boolean }): Scaffold[];
  /** @throws TournamentsError `unknown_template`, `template_archived` */
  createScaffold(leagueId: string, body: ScaffoldBody): Scaffold;
  /** Renames and/or replaces the slot list, then replans its schedules. @throws TournamentsError `not_found`, `unknown_template`, `template_archived` */
  updateScaffold(leagueId: string, id: number, patch: ScaffoldPatch): Scaffold;
  /** @throws TournamentsError `not_found`, `scaffold_in_use` */
  archiveScaffold(leagueId: string, id: number): void;

  listSchedules(leagueId: string): Schedule[];
  /** @throws TournamentsError `unknown_scaffold`, `scaffold_archived` */
  createSchedule(leagueId: string, body: ScheduleBody): Schedule;
  /** Then replans it. @throws TournamentsError `not_found`, `invalid_range` */
  updateSchedule(leagueId: string, id: number, patch: SchedulePatch): Schedule;
  /** Archives and replans it as if nothing fits; rows in play-tools keep their link. @throws TournamentsError `not_found` */
  archiveSchedule(leagueId: string, id: number): void;
  /** The next dates a rule produces from the creatable window's start, with each slot of the scaffold; saves nothing. */
  previewSchedule(leagueId: string, body: SchedulePreviewBody): SchedulePreview;

  /**
   * A one-off planned tournament from a template (its type isn't resolved here: `type` is null).
   * @throws TournamentsError `unknown_template`, `template_archived`, `date_too_far_past`, `date_too_far_ahead`, `already_planned`
   */
  createPlanned(leagueId: string, body: PlannedBody): UpcomingEntry;
  /**
   * Skip or unskip, move the date or time, or pick the series, while the row isn't in play-tools.
   * @throws TournamentsError `not_found`, `not_editable`, `date_too_far_past`, `date_too_far_ahead`
   */
  updatePlanned(leagueId: string, id: number, patch: PlannedPatch): { planned: UpcomingEntry; warnings: 'another_planned_at_time'[] };
  /**
   * Plans every schedule up to its horizon, then lists the planned tournaments and the league's play-tools ones
   * whose local date is in the range, by start. Reads play-tools as each connected professor.
   * @throws TournamentsError `invalid_range`
   */
  upcoming(leagueId: string, range: { from?: LocalDate; to?: LocalDate }): Promise<Upcoming>;
}

/** The play-tools reads this module makes, as one professor. */
export type TournamentsGateway = Pick<PlayToolsGateway, 'listTournaments' | 'listSeries' | 'listFormats' | 'listVenues'>;

export interface TournamentsDeps {
  db: Db;
  connections: Pick<PokemonConnectionService, 'getStatus' | 'listActingConnections'>;
  /** Play-tools as one professor's connection. */
  gateway: (connectionId: number) => TournamentsGateway;
  /** The league time zone (ADR-0006): the creatable window and Upcoming's dates are in it. */
  timeZone: string;
  now?: () => Date;
}

type TemplateRow = typeof tournamentTemplate.$inferSelect;
type ScheduleRow = typeof tournamentSchedule.$inferSelect;
type PlannedRow = typeof plannedTournament.$inferSelect;
/** A row's own date or time, kept across replans, and settings set on it before creation. */
type RowOverrides = SettingsOverrides & { localDate?: LocalDate };

/** Upcoming's default reach: the longest horizon. */
const UPCOMING_DAYS = 26 * 7;
/** Upcoming's longest range, so a year of planned tournaments fits. */
const MAX_UPCOMING_DAYS = 366;

/** How far ahead a preview looks: the recurrence engine's longest range. */
const PREVIEW_DAYS = 400;

export function createTournamentsService(deps: TournamentsDeps): TournamentsService {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  function templateView(r: TemplateRow): Template {
    return {
      id: r.id,
      name: r.name,
      organizerPlayerId: r.organizerPlayerId,
      product: r.product,
      category: r.category,
      type: r.eventType === 'premier' ? { kind: 'premier', seriesMatch: r.seriesMatch ?? '' } : { kind: 'custom' },
      venue: { id: r.venueId, label: r.venueLabel, timeZone: r.venueTimeZone, country: r.venueCountry },
      startTime: r.startTime,
      registration: r.registration as RegistrationSettings,
      contactEmail: r.contactEmail,
      contactPhone: r.contactPhone,
      details: r.details,
      eventWebsite: r.eventWebsite,
      archived: r.archivedAt !== null,
    };
  }

  /** Template fields as columns; only those given. */
  function templateColumns(t: Partial<TemplateBody>) {
    return {
      ...(t.name !== undefined && { name: t.name }),
      ...(t.organizerPlayerId !== undefined && { organizerPlayerId: t.organizerPlayerId }),
      ...(t.product !== undefined && { product: t.product }),
      ...(t.category !== undefined && { category: t.category }),
      ...(t.type !== undefined && { eventType: t.type.kind, seriesMatch: t.type.kind === 'premier' ? t.type.seriesMatch : null }),
      ...(t.venue !== undefined && { venueId: t.venue.id, venueLabel: t.venue.label, venueTimeZone: t.venue.timeZone, venueCountry: t.venue.country }),
      ...(t.startTime !== undefined && { startTime: t.startTime }),
      ...(t.registration !== undefined && { registration: t.registration }),
      ...(t.contactEmail !== undefined && { contactEmail: t.contactEmail }),
      ...(t.contactPhone !== undefined && { contactPhone: t.contactPhone }),
      ...(t.details !== undefined && { details: t.details }),
      ...(t.eventWebsite !== undefined && { eventWebsite: t.eventWebsite }),
    };
  }

  /** Any connected professor of the league, whatever their status: a reconnect doesn't change who they are. */
  function requireOrganizer(playerId: string) {
    if (!deps.connections.listActingConnections().some((c) => c.professorPlayerId === playerId)) {
      throw new TournamentsError(
        'organizer_not_connected',
        `Professor ${playerId} isn't connected. Connect their Pokémon account in Settings to create tournaments as them.`,
      );
    }
  }

  function templateRow(leagueId: string, id: number): TemplateRow {
    const row = db.select().from(tournamentTemplate).where(and(eq(tournamentTemplate.leagueId, leagueId), eq(tournamentTemplate.id, id))).get();
    if (!row) throw new TournamentsError('not_found', 'No such template.');
    return row;
  }

  function scaffoldRow(leagueId: string, id: number) {
    const row = db.select().from(tournamentScaffold).where(and(eq(tournamentScaffold.leagueId, leagueId), eq(tournamentScaffold.id, id))).get();
    if (!row) throw new TournamentsError('not_found', 'No such scaffold.');
    return row;
  }

  function scaffoldView(row: typeof tournamentScaffold.$inferSelect): Scaffold {
    const slots = db.select().from(scaffoldSlot).where(eq(scaffoldSlot.scaffoldId, row.id)).orderBy(asc(scaffoldSlot.position)).all();
    return {
      id: row.id,
      name: row.name,
      archived: row.archivedAt !== null,
      slots: slots.map((s) => ({ position: s.position, templateId: s.templateId, dayOffset: s.dayOffset, startTime: s.startTime })),
    };
  }

  function scheduleRow(leagueId: string, id: number) {
    const row = db.select().from(tournamentSchedule).where(and(eq(tournamentSchedule.leagueId, leagueId), eq(tournamentSchedule.id, id))).get();
    if (!row) throw new TournamentsError('not_found', 'No such schedule.');
    return row;
  }

  function scheduleView(row: typeof tournamentSchedule.$inferSelect): Schedule {
    const scaffold = db.select().from(tournamentScaffold).where(eq(tournamentScaffold.id, row.scaffoldId)).get()!;
    return {
      id: row.id,
      scaffoldId: row.scaffoldId,
      scaffoldName: scaffold.name,
      rule: row.rule as ScheduleRule,
      startsOn: row.startsOn,
      endsOn: row.endsOn,
      horizonWeeks: row.horizonWeeks,
      paused: row.paused,
      archived: row.archivedAt !== null,
      createdThrough: row.createdThrough,
    };
  }

  /** A scaffold's slots with their start times resolved (slot, else template) and each template's venue zone. */
  function resolvedSlots(scaffoldId: number) {
    return db
      .select({ slot: scaffoldSlot, templateStart: tournamentTemplate.startTime, timeZone: tournamentTemplate.venueTimeZone })
      .from(scaffoldSlot)
      .innerJoin(tournamentTemplate, eq(scaffoldSlot.templateId, tournamentTemplate.id))
      .where(eq(scaffoldSlot.scaffoldId, scaffoldId))
      .orderBy(asc(scaffoldSlot.position))
      .all()
      .map(({ slot, templateStart, timeZone }) => ({
        position: slot.position,
        templateId: slot.templateId,
        dayOffset: slot.dayOffset,
        startTime: slot.startTime ?? templateStart,
        timeZone,
      }));
  }

  const today = () => dateIn(now(), deps.timeZone);

  function scheduleActive(schedule: ScheduleRow): boolean {
    if (schedule.paused || schedule.archivedAt) return false;
    return !db.select({ archivedAt: tournamentScaffold.archivedAt }).from(tournamentScaffold).where(eq(tournamentScaffold.id, schedule.scaffoldId)).get()?.archivedAt;
  }

  /** Brings one schedule's rows in line with it (ADR-0010 decision 4): see `planSchedule`. */
  function syncSchedule(leagueId: string, schedule: ScheduleRow) {
    const rows = db.select().from(plannedTournament).where(eq(plannedTournament.scheduleId, schedule.id)).all();
    const takenElsewhere = new Set(
      db
        .select({ scheduleId: plannedTournament.scheduleId, templateId: plannedTournament.templateId, localDate: plannedTournament.localDate, startTime: plannedTournament.startTime })
        .from(plannedTournament)
        .where(and(eq(plannedTournament.leagueId, leagueId), ne(plannedTournament.state, 'cancelled')))
        .all()
        .filter((r) => r.scheduleId !== schedule.id)
        .map((r) => eventKey(r.templateId, r.localDate, r.startTime)),
    );
    const plan = planSchedule({
      schedule: { rule: schedule.rule as ScheduleRule, startsOn: schedule.startsOn, endsOn: schedule.endsOn, horizonWeeks: schedule.horizonWeeks, active: scheduleActive(schedule) },
      slots: resolvedSlots(schedule.scaffoldId),
      rows: rows.map((r) => ({
        id: r.id,
        slotPosition: r.slotPosition!,
        occurrenceDate: r.occurrenceDate!,
        templateId: r.templateId,
        localDate: r.localDate,
        startTime: r.startTime,
        state: r.state,
        overrides: r.overrides as RowOverrides,
      })),
      today: today(),
      windowStart: creatableWindow(now(), deps.timeZone).from,
      takenElsewhere,
    });
    if (plan.delete.length > 0) db.delete(plannedTournament).where(inArray(plannedTournament.id, plan.delete)).run();
    for (const { id, ...set } of plan.update) db.update(plannedTournament).set(set).where(eq(plannedTournament.id, id)).run();
    if (plan.insert.length > 0) {
      db.insert(plannedTournament)
        .values(plan.insert.map((i) => ({ leagueId, scheduleId: schedule.id, ...i, createdAt: now() })))
        .onConflictDoNothing()
        .run();
    }
  }

  function replan(leagueId: string, scheduleId: number) {
    db.transaction(() => syncSchedule(leagueId, scheduleRow(leagueId, scheduleId)));
  }

  /** Every schedule of the league, planned up to its horizon: on every Upcoming read. */
  function materialise(leagueId: string) {
    db.transaction(() => {
      for (const s of db.select().from(tournamentSchedule).where(eq(tournamentSchedule.leagueId, leagueId)).all()) syncSchedule(leagueId, s);
    });
  }

  /** Another row of the template, not cancelled, already holding that date and time. */
  function rowAt(leagueId: string, templateId: number, localDate: LocalDate, startTime: string, except?: number) {
    return db
      .select({ id: plannedTournament.id })
      .from(plannedTournament)
      .where(
        and(
          eq(plannedTournament.leagueId, leagueId),
          eq(plannedTournament.templateId, templateId),
          eq(plannedTournament.localDate, localDate),
          eq(plannedTournament.startTime, startTime),
          ne(plannedTournament.state, 'cancelled'),
          except === undefined ? undefined : ne(plannedTournament.id, except),
        ),
      )
      .get();
  }

  function requireCreatable(localDate: LocalDate) {
    const problem = checkCreatable(localDate, now(), deps.timeZone);
    if (problem === 'date_too_far_past') {
      throw new TournamentsError(problem, `${localDate} is too far back. A tournament can be planned from ${creatableWindow(now(), deps.timeZone).from} on.`);
    }
    if (problem === 'date_too_far_ahead') throw new TournamentsError(problem, `${localDate} is more than 12 months ahead.`);
  }

  function organizerOf(playerId: string, conns: readonly ActingConnection[]): OrganizerView {
    const c = conns.find((x) => x.professorPlayerId === playerId);
    return { playerId, name: c?.professorName ?? null, connected: c?.status === 'connected', needsReconnect: c?.status === 'needs_reconnect' };
  }

  /** What the rows being listed refer to, loaded once. */
  interface EntryContext {
    templates: Map<number, TemplateRow>;
    schedules: Map<number, ScheduleRow & { active: boolean; positions: Set<number> }>;
    overrides: (typeof tournamentScheduleOverride.$inferSelect)[];
    conns: readonly ActingConnection[];
    /** Each organizer's series by player id: null when the read failed; absent when not read. */
    series: Map<string, readonly Series[] | null>;
  }

  function contextFor(rows: readonly PlannedRow[], series: EntryContext['series'] = new Map()): EntryContext {
    const templateIds = [...new Set(rows.map((r) => r.templateId))];
    const scheduleIds = [...new Set(rows.flatMap((r) => (r.scheduleId === null ? [] : [r.scheduleId])))];
    const schedules = scheduleIds.length === 0 ? [] : db.select().from(tournamentSchedule).where(inArray(tournamentSchedule.id, scheduleIds)).all();
    return {
      templates: new Map(
        (templateIds.length === 0 ? [] : db.select().from(tournamentTemplate).where(inArray(tournamentTemplate.id, templateIds)).all()).map((t) => [t.id, t]),
      ),
      schedules: new Map(
        schedules.map((s) => [
          s.id,
          {
            ...s,
            active: scheduleActive(s),
            positions: new Set(db.select({ p: scaffoldSlot.position }).from(scaffoldSlot).where(eq(scaffoldSlot.scaffoldId, s.scaffoldId)).all().map((x) => x.p)),
          },
        ]),
      ),
      overrides: scheduleIds.length === 0 ? [] : db.select().from(tournamentScheduleOverride).where(inArray(tournamentScheduleOverride.scheduleId, scheduleIds)).all(),
      conns: deps.connections.listActingConnections(),
      series,
    };
  }

  /** A row's type on its date, while it isn't in play-tools. */
  function typeFor(row: PlannedRow, template: TemplateRow, ctx: EntryContext): TypeResolution | null {
    if (!(REPLANNABLE.has(row.state) || row.state === 'creating' || row.state === 'unknown')) return null;
    const pick = row.seriesOverride;
    if (pick === 'custom' || (pick === null && template.eventType === 'custom')) return { kind: 'custom' };
    if (!ctx.series.has(template.organizerPlayerId)) return null;
    const list = ctx.series.get(template.organizerPlayerId);
    if (!list) return { kind: 'premier', status: 'unavailable', candidates: [] };
    const type: TemplateType = template.eventType === 'premier' ? { kind: 'premier', seriesMatch: template.seriesMatch ?? '' } : { kind: 'custom' };
    return resolveSeries({ type, product: template.product, country: template.venueCountry, date: row.localDate, pick }, list);
  }

  function entryOf(row: PlannedRow, ctx: EntryContext): UpcomingEntry {
    const template = ctx.templates.get(row.templateId)!;
    const schedule = row.scheduleId === null ? undefined : ctx.schedules.get(row.scheduleId);
    const scheduleOverrides = ctx.overrides
      .filter((o) => o.scheduleId === row.scheduleId && o.slotPosition === row.slotPosition)
      .map((o) => ({ effectiveFrom: o.effectiveFrom, fields: o.fields as SettingsOverrides }));
    const settings = resolveSettings(templateView(template), scheduleOverrides, row.overrides as SettingsOverrides, {
      occurrenceDate: row.occurrenceDate ?? row.localDate,
      localDate: row.localDate,
    });
    let startsAt: string | null = null;
    let timeProblem: LocalTimeError['reason'] | undefined;
    try {
      startsAt = localInstant(row.localDate, row.startTime, template.venueTimeZone).toISOString();
    } catch (err) {
      if (!(err instanceof LocalTimeError)) throw err;
      timeProblem = err.reason;
    }
    const organizer = organizerOf(template.organizerPlayerId, ctx.conns);
    const type = typeFor(row, template, ctx);
    const replannable = row.state === 'planned' || row.state === 'failed';
    const creatable =
      replannable &&
      organizer.connected &&
      startsAt !== null &&
      checkCreatable(row.localDate, now(), deps.timeZone) === null &&
      type !== null &&
      (type.kind === 'custom' || type.status === 'resolved');
    return {
      plannedId: row.id,
      tournamentId: row.tournamentId,
      scheduleId: row.scheduleId,
      slotPosition: row.slotPosition,
      occurrenceDate: row.occurrenceDate,
      templateId: row.templateId,
      name: settings.name,
      localDate: row.localDate,
      startTime: row.startTime,
      startsAt,
      ...(timeProblem && { timeProblem }),
      sanctionBy: sanctionBy(row.localDate),
      state: row.state,
      inSchedule: schedule ? fitsSchedule(schedule, schedule.positions, { slotPosition: row.slotPosition!, occurrenceDate: row.occurrenceDate! }) : null,
      organizer,
      product: template.product,
      category: settings.category,
      type,
      displayId: row.displayId,
      upstreamStatus: row.upstreamStatus,
      errorCode: row.errorCode,
      actions: [...(creatable ? (['create'] as const) : []), ...(replannable ? (['skip'] as const) : []), ...(row.state === 'skipped' ? (['unskip'] as const) : [])],
    };
  }

  function plannedRow(leagueId: string, id: number): PlannedRow {
    const row = db.select().from(plannedTournament).where(and(eq(plannedTournament.leagueId, leagueId), eq(plannedTournament.id, id))).get();
    if (!row) throw new TournamentsError('not_found', 'No such planned tournament.');
    return row;
  }

  /** Every slot's template is the league's and not archived. */
  function checkSlotTemplates(leagueId: string, slots: ScaffoldBody['slots']) {
    const ids = [...new Set(slots.map((s) => s.templateId))];
    const found = db.select().from(tournamentTemplate).where(and(eq(tournamentTemplate.leagueId, leagueId), inArray(tournamentTemplate.id, ids))).all();
    for (const id of ids) {
      const t = found.find((r) => r.id === id);
      if (!t) throw new TournamentsError('unknown_template', `No template ${id}.`, { templateId: id });
      if (t.archivedAt) throw new TournamentsError('template_archived', `“${t.name}” is archived.`, { templateId: id });
    }
  }

  return {
    listTemplates(leagueId, opts) {
      const rows = db
        .select()
        .from(tournamentTemplate)
        .where(and(eq(tournamentTemplate.leagueId, leagueId), opts.archived ? undefined : isNull(tournamentTemplate.archivedAt)))
        .orderBy(asc(tournamentTemplate.name), asc(tournamentTemplate.id))
        .all();
      return rows.map(templateView);
    },

    createTemplate(leagueId, body) {
      requireOrganizer(body.organizerPlayerId);
      const at = now();
      const row = db
        .insert(tournamentTemplate)
        .values({ leagueId, ...(templateColumns(body) as Required<ReturnType<typeof templateColumns>>), createdAt: at, updatedAt: at })
        .returning()
        .get();
      return templateView(row);
    },

    updateTemplate(leagueId, id, patch) {
      const current = templateView(templateRow(leagueId, id));
      if (patch.organizerPlayerId !== undefined) requireOrganizer(patch.organizerPlayerId);
      const merged = { ...current, ...patch };
      if (merged.contactEmail === null && merged.contactPhone === null) {
        throw new TournamentsError('contact_required', 'Give a contact email or phone.');
      }
      const row = db
        .update(tournamentTemplate)
        .set({ ...templateColumns(patch), updatedAt: now() })
        .where(eq(tournamentTemplate.id, id))
        .returning()
        .get();
      return templateView(row);
    },

    archiveTemplate(leagueId, id) {
      const row = templateRow(leagueId, id);
      const users = db
        .selectDistinct({ id: tournamentScaffold.id })
        .from(scaffoldSlot)
        .innerJoin(tournamentScaffold, eq(scaffoldSlot.scaffoldId, tournamentScaffold.id))
        .where(and(eq(scaffoldSlot.templateId, id), isNull(tournamentScaffold.archivedAt)))
        .orderBy(asc(tournamentScaffold.id))
        .all();
      if (users.length > 0) {
        throw new TournamentsError('template_in_use', `“${row.name}” is used by a scaffold. Archive or change the scaffold first.`, {
          scaffoldIds: users.map((u) => u.id),
        });
      }
      if (!row.archivedAt) db.update(tournamentTemplate).set({ archivedAt: now() }).where(eq(tournamentTemplate.id, id)).run();
    },

    listScaffolds(leagueId, opts) {
      return db
        .select()
        .from(tournamentScaffold)
        .where(and(eq(tournamentScaffold.leagueId, leagueId), opts.archived ? undefined : isNull(tournamentScaffold.archivedAt)))
        .orderBy(asc(tournamentScaffold.name), asc(tournamentScaffold.id))
        .all()
        .map(scaffoldView);
    },

    createScaffold(leagueId, body) {
      checkSlotTemplates(leagueId, body.slots);
      return db.transaction(() => {
        const row = db.insert(tournamentScaffold).values({ leagueId, name: body.name, createdAt: now() }).returning().get();
        db.insert(scaffoldSlot)
          .values(body.slots.map((s, position) => ({ scaffoldId: row.id, position, ...s })))
          .run();
        return scaffoldView(row);
      });
    },

    updateScaffold(leagueId, id, patch) {
      scaffoldRow(leagueId, id);
      if (patch.slots) checkSlotTemplates(leagueId, patch.slots);
      return db.transaction(() => {
        if (patch.name !== undefined) db.update(tournamentScaffold).set({ name: patch.name }).where(eq(tournamentScaffold.id, id)).run();
        if (patch.slots) {
          db.delete(scaffoldSlot).where(eq(scaffoldSlot.scaffoldId, id)).run();
          db.insert(scaffoldSlot)
            .values(patch.slots.map((s, position) => ({ scaffoldId: id, position, ...s })))
            .run();
          for (const s of db.select().from(tournamentSchedule).where(eq(tournamentSchedule.scaffoldId, id)).all()) syncSchedule(leagueId, s);
        }
        return scaffoldView(scaffoldRow(leagueId, id));
      });
    },

    archiveScaffold(leagueId, id) {
      const row = scaffoldRow(leagueId, id);
      const users = db
        .select({ id: tournamentSchedule.id })
        .from(tournamentSchedule)
        .where(and(eq(tournamentSchedule.scaffoldId, id), isNull(tournamentSchedule.archivedAt)))
        .orderBy(asc(tournamentSchedule.id))
        .all();
      if (users.length > 0) {
        throw new TournamentsError('scaffold_in_use', `“${row.name}” is used by a schedule. Delete the schedule first.`, {
          scheduleIds: users.map((u) => u.id),
        });
      }
      if (!row.archivedAt) db.update(tournamentScaffold).set({ archivedAt: now() }).where(eq(tournamentScaffold.id, id)).run();
    },

    listSchedules(leagueId) {
      return db.select().from(tournamentSchedule).where(eq(tournamentSchedule.leagueId, leagueId)).orderBy(asc(tournamentSchedule.id)).all().map(scheduleView);
    },

    createSchedule(leagueId, body) {
      const scaffold = db
        .select()
        .from(tournamentScaffold)
        .where(and(eq(tournamentScaffold.leagueId, leagueId), eq(tournamentScaffold.id, body.scaffoldId)))
        .get();
      if (!scaffold) throw new TournamentsError('unknown_scaffold', `No scaffold ${body.scaffoldId}.`, { scaffoldId: body.scaffoldId });
      if (scaffold.archivedAt) throw new TournamentsError('scaffold_archived', `“${scaffold.name}” is archived.`, { scaffoldId: body.scaffoldId });
      const row = db
        .insert(tournamentSchedule)
        .values({
          leagueId,
          scaffoldId: body.scaffoldId,
          rule: body.rule,
          startsOn: body.startsOn,
          endsOn: body.endsOn,
          horizonWeeks: body.horizonWeeks ?? defaultHorizonWeeks(body.rule),
          paused: body.paused ?? false,
          createdAt: now(),
        })
        .returning()
        .get();
      return scheduleView(row);
    },

    updateSchedule(leagueId, id, patch) {
      const current = scheduleRow(leagueId, id);
      const startsOn = patch.startsOn ?? current.startsOn;
      const endsOn = patch.endsOn === undefined ? current.endsOn : patch.endsOn;
      if (endsOn !== null && endsOn < startsOn) throw new TournamentsError('invalid_range', 'The last date is before the first.');
      const row = db
        .update(tournamentSchedule)
        .set({
          ...(patch.rule !== undefined && { rule: patch.rule }),
          startsOn,
          endsOn,
          ...(patch.horizonWeeks !== undefined && { horizonWeeks: patch.horizonWeeks }),
          ...(patch.paused !== undefined && { paused: patch.paused }),
        })
        .where(eq(tournamentSchedule.id, id))
        .returning()
        .get();
      replan(leagueId, id);
      return scheduleView(row);
    },

    archiveSchedule(leagueId, id) {
      const row = scheduleRow(leagueId, id);
      if (!row.archivedAt) db.update(tournamentSchedule).set({ archivedAt: now() }).where(eq(tournamentSchedule.id, id)).run();
      replan(leagueId, id);
    },

    previewSchedule(leagueId, body) {
      const window = creatableWindow(now(), deps.timeZone);
      const range = { from: window.from, to: addDays(window.from, PREVIEW_DAYS - 1) };
      const slots = body.scaffoldId === undefined ? [] : resolvedSlots(scaffoldRow(leagueId, body.scaffoldId).id);
      return {
        dates: occurrenceDates(body.rule, body, range)
          .slice(0, body.count)
          .map((occurrenceDate) => ({
            occurrenceDate,
            slots: slots.flatMap((slot) =>
              expandSchedule(
                { rule: body.rule, startsOn: occurrenceDate, endsOn: occurrenceDate, slots: [slot], timeZone: slot.timeZone },
                { from: occurrenceDate, to: occurrenceDate },
              ).map((o) => ({
                position: o.slotPosition,
                localDate: o.localDate,
                startTime: o.startTime,
                startsAt: o.startsAt?.toISOString() ?? null,
                ...(o.timeProblem && { timeProblem: o.timeProblem }),
              })),
            ),
          })),
      };
    },

    createPlanned(leagueId, body) {
      const template = db
        .select()
        .from(tournamentTemplate)
        .where(and(eq(tournamentTemplate.leagueId, leagueId), eq(tournamentTemplate.id, body.templateId)))
        .get();
      if (!template) throw new TournamentsError('unknown_template', `No template ${body.templateId}.`, { templateId: body.templateId });
      if (template.archivedAt) throw new TournamentsError('template_archived', `“${template.name}” is archived.`, { templateId: body.templateId });
      requireCreatable(body.localDate);
      const startTime = body.startTime ?? template.startTime;
      const row = db.transaction(() => {
        const clash = rowAt(leagueId, template.id, body.localDate, startTime);
        if (clash) {
          throw new TournamentsError('already_planned', `“${template.name}” is already planned on ${body.localDate} at ${startTime}.`, {
            plannedTournamentId: clash.id,
          });
        }
        return db.insert(plannedTournament).values({ leagueId, templateId: template.id, localDate: body.localDate, startTime, createdAt: now() }).returning().get();
      });
      return entryOf(row, contextFor([row]));
    },

    updatePlanned(leagueId, id, patch) {
      const row = plannedRow(leagueId, id);
      if (!REPLANNABLE.has(row.state)) {
        throw new TournamentsError('not_editable', 'This tournament has reached play-tools, or is being created. Change it there, or with Edit….', { state: row.state });
      }
      const warnings: 'another_planned_at_time'[] = [];
      const overrides = { ...(row.overrides as RowOverrides) };
      const localDate = patch.localDate ?? row.localDate;
      const startTime = patch.startTime ?? row.startTime;
      if (patch.localDate !== undefined) {
        requireCreatable(patch.localDate);
        overrides.localDate = patch.localDate;
      }
      if (patch.startTime !== undefined) overrides.startTime = patch.startTime;
      if ((patch.localDate !== undefined || patch.startTime !== undefined) && rowAt(leagueId, row.templateId, localDate, startTime, row.id)) {
        warnings.push('another_planned_at_time');
      }
      const state: PlannedRowState = patch.skipped === true ? 'skipped' : patch.skipped === false && row.state === 'skipped' ? 'planned' : row.state;
      const updated = db
        .update(plannedTournament)
        .set({ localDate, startTime, overrides, state, ...(patch.seriesId !== undefined && { seriesOverride: patch.seriesId }) })
        .where(eq(plannedTournament.id, id))
        .returning()
        .get();
      return { planned: entryOf(updated, contextFor([updated])), warnings };
    },

    async upcoming(leagueId, range) {
      const from = range.from ?? creatableWindow(now(), deps.timeZone).from;
      const to = range.to ?? addDays(today(), UPCOMING_DAYS);
      if (to < from || addDays(from, MAX_UPCOMING_DAYS - 1) < to) {
        throw new TournamentsError('invalid_range', `Choose a range of at most ${MAX_UPCOMING_DAYS} days, ending after it starts.`);
      }
      materialise(leagueId);
      const rows = db
        .select()
        .from(plannedTournament)
        .where(and(eq(plannedTournament.leagueId, leagueId), gte(plannedTournament.localDate, from), lte(plannedTournament.localDate, to)))
        .all();
      const ctx = contextFor(rows);
      const tournaments = rows
        .map((r) => entryOf(r, ctx))
        .sort((a, b) => a.localDate.localeCompare(b.localDate) || a.startTime.localeCompare(b.startTime) || (a.plannedId ?? 0) - (b.plannedId ?? 0));
      return { timeZone: deps.timeZone, from, to, tournaments, upstream: 'read', unread: [] };
    },
  };
}
