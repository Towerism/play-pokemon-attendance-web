import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { expandSchedule, occurrenceDates } from '../../../shared/schedule/expand';
import type { ScheduleRule } from '../../../shared/schedule/rule';
import type {
  ScaffoldBody,
  ScaffoldPatch,
  ScheduleBody,
  SchedulePatch,
  SchedulePreviewBody,
  TemplateBody,
  TemplatePatch,
} from '../../../shared/schemas/tournaments';
import type { Db } from '../../db/client';
import { scaffoldSlot, tournamentScaffold, tournamentSchedule, tournamentTemplate } from '../../db/schema';
import type { PokemonConnectionService } from '../pokemon/connection';
import type { PlayToolsGateway } from '../pokemon/ports/play-tools-gateway';
import { addDays, type LocalDate } from './dates';
import { TournamentsError } from './errors';
import { defaultHorizonWeeks } from './plan';
import { creatableWindow } from './window';
import type { RegistrationSettings, TemplateVenue } from './settings';
import type { TemplateType } from './series';

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
      return scheduleView(row);
    },

    archiveSchedule(leagueId, id) {
      const row = scheduleRow(leagueId, id);
      if (!row.archivedAt) db.update(tournamentSchedule).set({ archivedAt: now() }).where(eq(tournamentSchedule.id, id)).run();
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
  };
}
