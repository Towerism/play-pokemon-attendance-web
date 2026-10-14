import { and, asc, eq, gte, inArray, isNull } from 'drizzle-orm';
import type { ApplyBody, EditBody, EditTarget, TemplatePatch } from '../../../shared/schemas/tournaments';
import { dateIn } from '../../../shared/time/local-time';
import type { SessionDate } from '../../../shared/types/ids';
import type { Db } from '../../db/client';
import { plannedTournament, scaffoldSlot, tournamentScaffold, tournamentSchedule, tournamentScheduleOverride, tournamentTemplate } from '../../db/schema';
import type { ActingConnection, PokemonConnectionService } from '../pokemon/connection';
import { PokemonUpstreamError } from '../pokemon/ports/errors';
import type { TournamentChanges, TournamentDetails } from '../pokemon/ports/play-tools-gateway';
import type { StaffingService } from '../staffing/service';
import { isShortNotice } from './create';
import type { LocalDate } from './dates';
import {
  type CarriedField,
  type EditChanges,
  type EditValues,
  type Shadow,
  applyValues,
  carriedFields,
  diffValues,
  editDelta,
  formValues,
  pickChanges,
  rescheduleWindow,
  selectScope,
  shadowing,
  siblingFields,
} from './edit';
import { TournamentsError } from './errors';
import type { LiveReads } from './live-reads';
import { REPLANNABLE } from './plan';
import type { TemplateSettings } from './settings';
import { type WindowProblem, checkCreatable, creatableWindow } from './window';

type PlannedRow = typeof plannedTournament.$inferSelect;
type TemplateRow = typeof tournamentTemplate.$inferSelect;
type ScheduleRow = typeof tournamentSchedule.$inferSelect;

/** The most tournaments one edit job takes, and one preview reads (ADR-0010 decision 11). */
export const MAX_EDIT = 60;

/** The edit form (`GET /tournaments/{id}/edit`, #93). */
export interface EditForm {
  target: { plannedId: number | null; tournamentId: string | null; displayId: string | null; inPlayTools: boolean };
  values: EditValues;
  readOnly: {
    league: { displayId: string | null };
    organizer: { playerId: string; name: string | null };
    product: string | null;
    type: { kind: 'custom' } | { kind: 'premier'; seriesId: string | null; name: string | null };
  };
  editable: boolean;
  lockedReason: 'tournament_locked' | null;
  upstreamStatus: string | null;
  /** In league-`TZ` local dates; null for a tournament not in play-tools. */
  reschedule: { opensOn: LocalDate; closesOn: LocalDate; open: boolean } | null;
  schedule: { scheduleId: number; slotPosition: number; occurrenceDate: LocalDate; scaffoldName: string; siblings: number } | null;
  templateId: number | null;
}

export interface PreviewTarget {
  /** `p:<plannedId>`, or `t:<guid>` for a play-tools tournament no row holds. */
  key: string;
  plannedId: number | null;
  tournamentId: string | null;
  displayId: string | null;
  name: string;
  localDate: LocalDate;
  startTime: string;
  /** Another slot of the scaffold on the same date. */
  sibling: boolean;
}

export interface PreviewEntry extends PreviewTarget {
  changes: ReturnType<typeof diffValues>;
}

export type EditWarning = 'another_planned_at_time' | 'may_need_approval' | 'series_window_unknown';

export interface EditPreview {
  key: string;
  reschedule: boolean;
  shortNotice: boolean;
  inPlayTools: PreviewEntry[];
  planned: PreviewEntry[];
  /** `reason` is a state (`cancelled`, `creating`, `unknown`, `before_window`), `no_change`, `unreadable` (with `code`), or a refusal code. */
  leftOut: { entry: PreviewTarget; reason: string; code?: string }[];
  count: number;
  warnings: EditWarning[];
  template: { templateId: number; schedules: { scheduleId: number; scaffoldName: string }[]; shadowedBy: Shadow[] } | null;
}

/** One tournament an edit job sends to, as stored on its item. */
export interface EditItem {
  plannedId: number | null;
  tournamentId: string;
  label: string;
  changes: EditChanges;
  professorPlayerId: string;
  /** A short-notice reschedule, acknowledged when the job started. */
  shortNotice: boolean;
}

/** What an apply does: the preview again, minus what was excluded. */
export interface EditPlan {
  preview: EditPreview;
  label: string;
  reschedule: boolean;
  items: EditItem[];
  local: { plannedId: number; changes: EditChanges }[];
  /** Rows a schedule override would otherwise change: held at what they resolve to now. */
  pins: { plannedId: number; changes: EditChanges }[];
  scheduleOverrides: { scheduleId: number; slotPosition: number; effectiveFrom: LocalDate; fields: EditChanges }[];
  template: { templateId: number; fields: EditChanges } | null;
  clear: Shadow[];
}

/** An edit item's turn, from a fresh read as its organizer. */
export type ItemRead =
  | { kind: 'send'; connectionId: number; delta: TournamentChanges; startsAt: Date | null; localDate: LocalDate | null; reschedule: boolean; read: TournamentDetails }
  | { kind: 'already_applied'; connectionId: number; read: TournamentDetails }
  | { kind: 'fail'; code: string; message: string; connectionId?: number; error?: PokemonUpstreamError; read?: TournamentDetails };

/** What the submission module's `tournament_edit` job uses (#93), as `creation` is for creates. */
export interface TournamentEditing {
  /**
   * The preview worked out again, minus `excluded`, with the apply's own refusals. Reads only.
   * @throws TournamentsError (the preview's), `short_notice_not_acknowledged`, `nothing_to_edit`
   */
  prepare(leagueId: string, target: EditTarget, body: ApplyBody): Promise<EditPlan>;
  /** The local writes; call inside the job's transaction. Returns how many planned rows changed. */
  applyLocal(leagueId: string, plan: EditPlan, by: string): number;
  /** Fresh read, checks and delta. @throws PokemonUpstreamError `not_connected`, `needs_reconnect`, `forbidden`: the job stops */
  readItem(leagueId: string, item: EditItem): Promise<ItemRead>;
  /** The edit landed: the planned row takes the changes, and a moved tournament's staff move with it. */
  recordEdited(leagueId: string, item: EditItem, read: Extract<ItemRead, { kind: 'send' | 'already_applied' }>): void;
  recordReconciled(leagueId: string, plannedId: number, fresh: { displayId: string | null; status: string | null }): void;
  /** Null when the date is still in the creatable window, by this module's clock. */
  windowProblem(localDate: LocalDate): WindowProblem | null;
  /** Less than 7 days ahead now (ADR-0010 decision 6): a retry of a reschedule that has become short notice is refused. */
  isShortNotice(localDate: LocalDate): boolean;
}

/** The service internals editing works with. */
export interface EditingContext {
  db: Db;
  connections: Pick<PokemonConnectionService, 'getStatus' | 'listActingConnections'>;
  gateway: (connectionId: number) => Pick<import('./service').TournamentsGateway, 'getTournament'>;
  live: LiveReads;
  staffing?: Pick<StaffingService, 'moveTournament'>;
  timeZone: string;
  now: () => Date;
  today: () => LocalDate;
  plannedRow(leagueId: string, id: number): PlannedRow;
  /** Each row's settings as it would be created now (template, schedule overrides, row overrides). */
  settingsFor(rows: readonly PlannedRow[]): Map<number, TemplateSettings>;
  rowAt(leagueId: string, templateId: number, localDate: LocalDate, startTime: string, except?: number): { id: number } | undefined;
  templateColumns(t: TemplatePatch): Record<string, unknown>;
}

/** Upstream errors after which nothing more is sent as that organizer (ADR-0010 decision 5). */
const STOPS: ReadonlySet<string> = new Set(['forbidden', 'needs_reconnect', 'not_connected']);
/** Reads that mean "not this professor's", when looking for who organizes a guid. */
const NOT_THEIRS: ReadonlySet<string> = new Set(['not_found', 'forbidden', 'refused']);
const DEAD = new Set(['cancelled', 'complete', 'deleted', 'invalidated']);
/** A tournament with no template: series windows and venues are asked for the US (ADR-0010 update #91). */
const DEFAULT_COUNTRY = 'US';

interface Resolved {
  group: string;
  leagueDisplayId: string | null;
  row: PlannedRow | null;
  template: TemplateRow | null;
  schedule: ScheduleRow | null;
  settings: TemplateSettings | null;
  upstream: { tournamentId: string; read: TournamentDetails; organizer: ActingConnection } | null;
}

interface Check {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export function createEditing(ctx: EditingContext): { editForm: (l: string, t: EditTarget) => Promise<EditForm>; editPreview: (l: string, t: EditTarget, b: EditBody) => Promise<EditPreview>; editing: TournamentEditing } {
  const { db } = ctx;

  function acting(playerId: string): ActingConnection | undefined {
    return ctx.connections.listActingConnections().find((c) => c.professorPlayerId === playerId);
  }

  /** The organizer's connection for a request: refused when they aren't connected or must reconnect. */
  function requireActing(playerId: string): ActingConnection {
    const c = acting(playerId);
    if (!c) {
      throw new TournamentsError('organizer_not_connected', `Professor ${playerId} isn't connected. Connect their Pokémon account in Settings to edit as them.`, {
        professorPlayerId: playerId,
      });
    }
    if (c.status === 'needs_reconnect') {
      throw new TournamentsError('needs_reconnect', `Reconnect ${c.professorName ?? `Professor ${playerId}`} in Settings.`, { professorPlayerId: playerId });
    }
    return c;
  }

  async function read(c: ActingConnection, tournamentId: string): Promise<TournamentDetails> {
    try {
      return await ctx.gateway(c.id).getTournament(tournamentId);
    } catch (err) {
      if (err instanceof PokemonUpstreamError && err.code === 'not_found') throw new TournamentsError('not_found', 'play-tools no longer has this tournament.');
      throw err;
    }
  }

  /** A fresh read as the tournament's organizer (ADR-0009): `first` reads it, and the organizer it names acts. */
  async function asOrganizer(group: string, tournamentId: string, first: ActingConnection, fresh: TournamentDetails) {
    if (fresh.groupId !== group) throw new TournamentsError('not_found', "This tournament isn't the league's.");
    if (fresh.organizerPlayerId === first.professorPlayerId) return { tournamentId, read: fresh, organizer: first };
    const organizer = requireActing(fresh.organizerPlayerId);
    return { tournamentId, read: await read(organizer, tournamentId), organizer };
  }

  async function resolve(leagueId: string, target: EditTarget): Promise<Resolved> {
    const status = ctx.connections.getStatus(leagueId);
    const group = status.league?.id;
    if (!group) throw new TournamentsError('league_not_selected', 'Choose the league in Settings first.');
    const row =
      target.kind === 'planned'
        ? ctx.plannedRow(leagueId, target.id)
        : (db
            .select()
            .from(plannedTournament)
            .where(and(eq(plannedTournament.leagueId, leagueId), eq(plannedTournament.tournamentId, target.id)))
            .get() ?? null);
    const base = { group, leagueDisplayId: status.league?.displayId ?? null };
    if (!row) {
      const guid = (target as Extract<EditTarget, { kind: 'tournament' }>).id;
      for (const c of ctx.connections.listActingConnections().filter((x) => x.status === 'connected')) {
        let fresh: TournamentDetails;
        try {
          fresh = await ctx.gateway(c.id).getTournament(guid);
        } catch (err) {
          if (err instanceof PokemonUpstreamError && NOT_THEIRS.has(err.code)) continue;
          throw err;
        }
        return { ...base, row: null, template: null, schedule: null, settings: null, upstream: await asOrganizer(group, guid, c, fresh) };
      }
      throw new TournamentsError('not_found', 'No connected professor can read this tournament in play-tools.');
    }
    if (row.state === 'creating' || row.state === 'unknown' || row.state === 'cancelled') {
      throw new TournamentsError('not_editable', 'This tournament is being created, may have been created, or is cancelled.', { state: row.state });
    }
    const template = db.select().from(tournamentTemplate).where(eq(tournamentTemplate.id, row.templateId)).get()!;
    const schedule = row.scheduleId === null ? null : (db.select().from(tournamentSchedule).where(eq(tournamentSchedule.id, row.scheduleId)).get() ?? null);
    const settings = ctx.settingsFor([row]).get(row.id)!;
    let upstream: Resolved['upstream'] = null;
    if (row.state === 'created' && row.tournamentId) {
      const c = requireActing(template.organizerPlayerId);
      upstream = await asOrganizer(group, row.tournamentId, c, await read(c, row.tournamentId));
    }
    return { ...base, row, template, schedule, settings, upstream };
  }

  const locked = (r: TournamentDetails) =>
    r.applicationState === 'cancelled' || DEAD.has(r.status) || (r.editableUntil !== null && ctx.now() > r.editableUntil);

  /** A planned row's values, from its resolved settings. */
  function rowValues(row: PlannedRow, s: TemplateSettings): EditValues {
    return {
      name: s.name,
      category: s.category,
      venue: s.venue,
      localDate: row.localDate,
      startTime: row.startTime,
      registration: s.registration,
      contactEmail: s.contactEmail,
      contactPhone: s.contactPhone,
      details: s.details,
      eventWebsite: s.eventWebsite,
    };
  }

  const fallbackOf = (s: TemplateSettings | null, read: TournamentDetails) => ({
    timeZone: s?.venue.timeZone ?? ctx.timeZone,
    country: s?.venue.country ?? DEFAULT_COUNTRY,
    venueLabel: s && read.venue?.id === s.venue.id ? s.venue.label : null,
  });

  /**
   * The local refusals for a change to a tournament in play-tools (ADR-0010 decisions 8 and 11), from a fresh read:
   * the reschedule and creatable windows and the series window for a date change, the series' formats, the venue,
   * and the delta's own problems. A series play-tools no longer lists can't be checked: `seriesUnknown`.
   */
  async function check(r: TournamentDetails, changes: EditChanges, c: ActingConnection, group: string, country: string) {
    const out: { problem: Check | null; seriesUnknown: boolean } = { problem: null, seriesUnknown: false };
    const zone = r.venue?.timeZone ?? ctx.timeZone;
    const current = r.startsAt ? dateIn(r.startsAt, zone) : null;
    const reschedule = changes.localDate !== undefined && changes.localDate !== current;
    if (reschedule && r.startsAt) {
      const window = rescheduleWindow(dateIn(r.startsAt, ctx.timeZone), ctx.today());
      if (ctx.today() < window.opensOn) {
        out.problem = { code: 'reschedule_window_not_open', message: `This tournament can be moved from ${window.opensOn}. To move it sooner, cancel it and create a new one.`, details: { opensOn: window.opensOn } };
        return out;
      }
      if (ctx.today() > window.closesOn) {
        out.problem = { code: 'reschedule_window_closed', message: `This tournament could be moved until ${window.closesOn}.`, details: { closesOn: window.closesOn } };
        return out;
      }
    }
    if (reschedule) {
      const problem = checkCreatable(changes.localDate!, ctx.now(), ctx.timeZone);
      if (problem) {
        out.problem = { code: problem, message: problem === 'date_too_far_past' ? `${changes.localDate} is too far back.` : `${changes.localDate} is more than 12 months ahead.` };
        return out;
      }
    }
    if (r.series && (reschedule || changes.category !== undefined)) {
      const listed = (await ctx.live.series(c.id, group)).find((s) => s.id === r.series!.id);
      if (!listed) out.seriesUnknown = reschedule;
      else {
        const window = listed.windows[changes.venue?.country ?? country];
        if (reschedule && window && (changes.localDate! < window.from || changes.localDate! > window.to)) {
          out.problem = {
            code: 'outside_series_window',
            message: `${listed.name} runs ${window.from} to ${window.to}. To hold it outside that, cancel it and create a new one.`,
            details: { window },
          };
          return out;
        }
        if (changes.category !== undefined && !listed.categories.includes(changes.category)) {
          out.problem = { code: 'format_not_in_series', message: `${listed.name} doesn't offer the format ${changes.category}.` };
          return out;
        }
      }
    }
    if (changes.venue !== undefined && changes.venue.id !== r.venue?.id) {
      const venues = await ctx.live.venues(c.id, group, changes.venue.country);
      if (!venues.some((v) => v.id === changes.venue!.id)) {
        out.problem = { code: 'venue_not_found', message: `${changes.venue.label} isn't in the organizer's address book.` };
        return out;
      }
    }
    const delta = editDelta(r, changes, { fallbackZone: zone });
    if (delta.problem === 'contact_required') out.problem = { code: 'contact_required', message: 'Give a contact email or phone.' };
    if (delta.problem === 'start_time_invalid') out.problem = { code: 'start_time_invalid', message: 'A clock change skips or repeats that start time.' };
    return out;
  }

  const keyOf = (row: PlannedRow | null, tournamentId: string | null) => (row ? `p:${row.id}` : `t:${tournamentId}`);

  interface Computed {
    preview: EditPreview;
    items: (EditItem & { key: string })[];
    local: { key: string; plannedId: number; changes: EditChanges }[];
    /** What each not-created row in scope resolves to now, for the carried fields: pinned if excluded or left out. */
    holds: Map<string, { plannedId: number; changes: EditChanges }>;
    resolved: Resolved;
    carried: CarriedField[];
    siblings: CarriedField[];
  }

  async function compute(leagueId: string, target: EditTarget, body: EditBody): Promise<Computed> {
    const t = await resolve(leagueId, target);
    const { changes } = body;
    if (t.upstream && locked(t.upstream.read)) throw new TournamentsError('tournament_locked', "play-tools no longer lets a professor edit this tournament.");
    const before = t.upstream ? formValues(t.upstream.read, fallbackOf(t.settings, t.upstream.read)) : rowValues(t.row!, t.settings!);
    const diff = diffValues(before, applyValues(before, changes));
    if (diff.length === 0) throw new TournamentsError('nothing_to_change', 'Nothing differs from what the tournament already has.');
    if ((body.scope !== 'this' || body.withSiblings) && !t.schedule) throw new TournamentsError('not_in_schedule', "This tournament isn't from a schedule.");
    if (body.updateTemplate && !t.template) throw new TournamentsError('no_template', "This tournament wasn't made from a template.");
    const reschedule = changes.localDate !== undefined && changes.localDate !== before.localDate;
    const warnings: EditWarning[] = [];

    const country = t.settings?.venue.country ?? DEFAULT_COUNTRY;
    if (t.upstream) {
      const checked = await check(t.upstream.read, changes, t.upstream.organizer, t.group, country);
      if (checked.problem) throw new TournamentsError(checked.problem.code as never, checked.problem.message, checked.problem.details);
      if (checked.seriesUnknown) warnings.push('series_window_unknown');
      if (reschedule) warnings.push('may_need_approval');
    } else if (reschedule) {
      const problem = checkCreatable(changes.localDate!, ctx.now(), ctx.timeZone);
      if (problem) throw new TournamentsError(problem, problem === 'date_too_far_past' ? `${changes.localDate} is too far back.` : `${changes.localDate} is more than 12 months ahead.`);
    }
    const after = applyValues(before, changes);
    if ((reschedule || changes.startTime !== undefined) && t.row && ctx.rowAt(leagueId, t.row.templateId, after.localDate, after.startTime, t.row.id)) {
      warnings.unshift('another_planned_at_time');
    }

    const primary: PreviewEntry = {
      key: keyOf(t.row, t.upstream?.tournamentId ?? null),
      plannedId: t.row?.id ?? null,
      tournamentId: t.upstream?.tournamentId ?? null,
      displayId: t.upstream?.read.displayId ?? t.row?.displayId ?? null,
      name: before.name,
      localDate: before.localDate,
      startTime: before.startTime,
      sibling: false,
      changes: diff,
    };
    const shortNotice = reschedule && isShortNotice(changes.localDate!, ctx.today());
    const out: Computed = {
      preview: { key: primary.key, reschedule, shortNotice, inPlayTools: [], planned: [], leftOut: [], count: 0, warnings, template: null },
      items: [],
      local: [],
      holds: new Map(),
      resolved: t,
      carried: carriedFields(changes, body.fields),
      siblings: [],
    };
    out.siblings = siblingFields(out.carried);
    if (t.upstream) {
      out.preview.inPlayTools.push(primary);
      out.items.push({
        key: primary.key,
        plannedId: t.row?.id ?? null,
        tournamentId: t.upstream.tournamentId,
        label: `${before.name} · ${before.localDate}`,
        changes,
        professorPlayerId: t.upstream.read.organizerPlayerId,
        shortNotice,
      });
    } else {
      out.preview.planned.push(primary);
      out.local.push({ key: primary.key, plannedId: t.row!.id, changes });
    }

    if (t.schedule && t.row && (body.scope !== 'this' || body.withSiblings)) await scope(leagueId, body, t, out);
    out.preview.count = out.preview.inPlayTools.length;

    if (body.updateTemplate) out.preview.template = templateSection(leagueId, t.template!, out);
    return out;
  }

  /** The other tournaments the edit reaches across the schedule (ADR-0010 decision 11). */
  async function scope(leagueId: string, body: EditBody, t: Resolved, out: Computed) {
    const rows = db.select().from(plannedTournament).where(eq(plannedTournament.scheduleId, t.schedule!.id)).all();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const scopeRow = (r: PlannedRow) => ({ id: r.id, slotPosition: r.slotPosition!, occurrenceDate: r.occurrenceDate!, localDate: r.localDate, state: r.state });
    const picked = selectScope(rows.map(scopeRow), scopeRow(t.row!), { scope: body.scope, withSiblings: body.withSiblings, windowStart: creatableWindow(ctx.now(), ctx.timeZone).from });
    const count = out.items.length + picked.inScope.filter((p) => byId.get(p.row.id)!.state === 'created').length;
    if (count > MAX_EDIT) {
      throw new TournamentsError('too_many_tournaments', `That reaches ${count} tournaments in play-tools; one edit takes at most ${MAX_EDIT}. Choose "this and later" from a later one.`, { count });
    }
    const notCreated = [...picked.inScope, ...picked.leftOut].map((p) => byId.get(p.row.id)!).filter((r) => r.state !== 'created' && r.state !== 'cancelled');
    const settings = ctx.settingsFor(notCreated);
    const targetOf = (r: PlannedRow, sibling: boolean, v?: EditValues): PreviewTarget => ({
      key: `p:${r.id}`,
      plannedId: r.id,
      tournamentId: r.tournamentId,
      displayId: r.displayId,
      name: v?.name ?? settings.get(r.id)?.name ?? '',
      localDate: v?.localDate ?? r.localDate,
      startTime: v?.startTime ?? r.startTime,
      sibling,
    });
    const fieldsFor = (sibling: boolean) => (sibling ? out.siblings : out.carried);
    const hold = (r: PlannedRow, sibling: boolean) => {
      const s = settings.get(r.id);
      if (s) out.holds.set(`p:${r.id}`, { plannedId: r.id, changes: pickChanges(rowValues(r, s) as EditChanges, fieldsFor(sibling)) });
    };

    for (const { row: sr, sibling, reason } of picked.leftOut) {
      const r = byId.get(sr.id)!;
      if (reason === 'creating' || reason === 'unknown') hold(r, sibling);
      out.preview.leftOut.push({ entry: targetOf(r, sibling), reason });
    }
    for (const { row: sr, sibling } of picked.inScope) {
      const r = byId.get(sr.id)!;
      const changes = pickChanges(body.changes, fieldsFor(sibling));
      if (r.state !== 'created') {
        hold(r, sibling);
        const before = rowValues(r, settings.get(r.id)!);
        const diff = diffValues(before, applyValues(before, changes));
        if (diff.length === 0) out.preview.leftOut.push({ entry: targetOf(r, sibling, before), reason: 'no_change' });
        else {
          out.preview.planned.push({ ...targetOf(r, sibling, before), changes: diff });
          out.local.push({ key: `p:${r.id}`, plannedId: r.id, changes });
        }
        continue;
      }
      const entry = await upstreamEntry(r, sibling, changes, t, targetOf);
      if ('reason' in entry) out.preview.leftOut.push(entry);
      else {
        out.preview.inPlayTools.push(entry.entry);
        out.items.push(entry.item);
      }
    }
  }

  /** A created row of the schedule, read fresh as its organizer: an entry to edit, or why it is left out. */
  async function upstreamEntry(
    r: PlannedRow,
    sibling: boolean,
    changes: EditChanges,
    t: Resolved,
    targetOf: (r: PlannedRow, sibling: boolean, v?: EditValues) => PreviewTarget,
  ): Promise<{ entry: PreviewTarget; reason: string; code?: string } | { entry: PreviewEntry; item: EditItem & { key: string } }> {
    const template = db.select().from(tournamentTemplate).where(eq(tournamentTemplate.id, r.templateId)).get()!;
    const leftOut = (reason: string, code?: string) => ({ entry: targetOf(r, sibling), reason, ...(code && { code }) });
    let c = acting(template.organizerPlayerId);
    if (!c) return leftOut('organizer_not_connected');
    if (c.status === 'needs_reconnect') return leftOut('needs_reconnect');
    let fresh: TournamentDetails;
    try {
      fresh = await ctx.gateway(c.id).getTournament(r.tournamentId!);
      if (fresh.organizerPlayerId !== c.professorPlayerId) {
        c = acting(fresh.organizerPlayerId);
        if (!c || c.status !== 'connected') return leftOut('organizer_not_connected');
        fresh = await ctx.gateway(c.id).getTournament(r.tournamentId!);
      }
    } catch (err) {
      if (!(err instanceof PokemonUpstreamError)) throw err;
      return leftOut('unreadable', err.code);
    }
    if (locked(fresh)) return leftOut('tournament_locked');
    const s = ctx.settingsFor([r]).get(r.id)!;
    const checked = await check(fresh, changes, c, t.group, s.venue.country);
    if (checked.problem) return leftOut(checked.problem.code);
    const before = formValues(fresh, fallbackOf(s, fresh));
    const diff = diffValues(before, applyValues(before, changes));
    const delta = editDelta(fresh, changes, { fallbackZone: before.venue.timeZone });
    if (diff.length === 0 || Object.keys(delta.changes).length === 0) return { entry: targetOf(r, sibling, before), reason: 'no_change' };
    return {
      entry: { ...targetOf(r, sibling, before), tournamentId: r.tournamentId, displayId: fresh.displayId, changes: diff },
      item: {
        key: `p:${r.id}`,
        plannedId: r.id,
        tournamentId: r.tournamentId!,
        label: `${before.name} · ${before.localDate}`,
        changes,
        professorPlayerId: fresh.organizerPlayerId,
        shortNotice: false,
      },
    };
  }

  /** **Update the template**: the schedules using it, and the overrides that would still win (#100). */
  function templateSection(leagueId: string, template: TemplateRow, out: Computed): EditPreview['template'] {
    const users = db
      .selectDistinct({ scheduleId: tournamentSchedule.id, scaffoldName: tournamentScaffold.name, slotPosition: scaffoldSlot.position })
      .from(scaffoldSlot)
      .innerJoin(tournamentScaffold, eq(scaffoldSlot.scaffoldId, tournamentScaffold.id))
      .innerJoin(tournamentSchedule, eq(tournamentSchedule.scaffoldId, tournamentScaffold.id))
      .where(and(eq(scaffoldSlot.templateId, template.id), isNull(tournamentSchedule.archivedAt)))
      .orderBy(asc(tournamentSchedule.id))
      .all();
    const slotKeys = new Set(users.map((u) => `${u.scheduleId}|${u.slotPosition}`));
    const scheduleIds = [...new Set(users.map((u) => u.scheduleId))];
    const overrides =
      scheduleIds.length === 0
        ? []
        : db
            .select()
            .from(tournamentScheduleOverride)
            .where(inArray(tournamentScheduleOverride.scheduleId, scheduleIds))
            .orderBy(asc(tournamentScheduleOverride.id))
            .all()
            .filter((o) => slotKeys.has(`${o.scheduleId}|${o.slotPosition}`));
    const editedHere = new Set(out.local.map((l) => l.plannedId));
    const rows = db
      .select()
      .from(plannedTournament)
      .where(and(eq(plannedTournament.leagueId, leagueId), eq(plannedTournament.templateId, template.id), gte(plannedTournament.localDate, creatableWindow(ctx.now(), ctx.timeZone).from)))
      .all()
      .filter((r) => REPLANNABLE.has(r.state) && !editedHere.has(r.id));
    return {
      templateId: template.id,
      schedules: scheduleIds.map((id) => ({ scheduleId: id, scaffoldName: users.find((u) => u.scheduleId === id)!.scaffoldName })),
      shadowedBy: shadowing({
        fields: out.carried,
        scheduleOverrides: overrides.map((o) => ({ ...o, fields: o.fields as Record<string, unknown> })),
        rows: rows.map((r) => ({ id: r.id, scheduleId: r.scheduleId, localDate: r.localDate, overrides: r.overrides as Record<string, unknown> })),
      }),
    };
  }

  function setPlanned(leagueId: string, id: number, set: Partial<typeof plannedTournament.$inferInsert>) {
    db.update(plannedTournament)
      .set(set)
      .where(and(eq(plannedTournament.leagueId, leagueId), eq(plannedTournament.id, id)))
      .run();
  }

  /** The row takes the changes as its own overrides; a date or time is also its column, as `PATCH /planned-tournaments` sets it. */
  function overrideRow(leagueId: string, plannedId: number, changes: EditChanges) {
    const row = ctx.plannedRow(leagueId, plannedId);
    setPlanned(leagueId, plannedId, {
      overrides: { ...(row.overrides as Record<string, unknown>), ...changes },
      ...(changes.localDate !== undefined && { localDate: changes.localDate }),
      ...(changes.startTime !== undefined && { startTime: changes.startTime }),
    });
  }

  function without(fields: Record<string, unknown>, drop: readonly string[]) {
    return Object.fromEntries(Object.entries(fields).filter(([k]) => !drop.includes(k)));
  }

  const editing: TournamentEditing = {
    async prepare(leagueId, target, body) {
      const c = await compute(leagueId, target, body);
      const excluded = new Set(body.excluded);
      const items = c.items.filter((i) => !excluded.has(i.key));
      const local = c.local.filter((l) => !excluded.has(l.key));
      const t = c.resolved;
      if (items.some((i) => i.shortNotice) && !body.acknowledgeShortNotice) {
        throw new TournamentsError('short_notice_not_acknowledged', 'The new date is less than 7 days away; the league is expected to sanction 7 days ahead.', {
          plannedTournamentIds: items.filter((i) => i.shortNotice).flatMap((i) => (i.plannedId === null ? [] : [i.plannedId])),
        });
      }
      const scheduleOverrides: EditPlan['scheduleOverrides'] = [];
      if (t.schedule && t.row && body.scope !== 'this') {
        const effectiveFrom = body.scope === 'later' ? t.row.occurrenceDate! : creatableWindow(ctx.now(), ctx.timeZone).from;
        const own = pickChanges(body.changes, c.carried);
        if (Object.keys(own).length > 0) scheduleOverrides.push({ scheduleId: t.schedule.id, slotPosition: t.row.slotPosition!, effectiveFrom, fields: own });
        if (body.withSiblings) {
          const fields = pickChanges(body.changes, c.siblings);
          const positions = db.select({ p: scaffoldSlot.position }).from(scaffoldSlot).where(eq(scaffoldSlot.scaffoldId, t.schedule.scaffoldId)).all();
          for (const { p } of positions) {
            if (p !== t.row.slotPosition && Object.keys(fields).length > 0) scheduleOverrides.push({ scheduleId: t.schedule.id, slotPosition: p, effectiveFrom, fields });
          }
        }
      }
      const kept = new Set(local.map((l) => l.plannedId));
      const pins = scheduleOverrides.length === 0 ? [] : [...c.holds.values()].filter((h) => !kept.has(h.plannedId) && Object.keys(h.changes).length > 0);
      let template: EditPlan['template'] = null;
      if (body.updateTemplate) {
        const fields = pickChanges(body.changes, c.carried);
        const merged = { ...t.template!, ...fields };
        if (merged.contactEmail === null && merged.contactPhone === null) throw new TournamentsError('contact_required', 'The template needs a contact email or phone.');
        if (Object.keys(fields).length > 0) template = { templateId: t.template!.id, fields };
      }
      if (items.length + local.length + scheduleOverrides.length + (template ? 1 : 0) === 0) {
        throw new TournamentsError('nothing_to_edit', 'Every tournament is excluded or left out.');
      }
      const label =
        items.length === 1
          ? `${c.preview.reschedule && items[0]!.key === c.preview.key ? 'Reschedule' : 'Edit'} ${items[0]!.label}`
          : `Edit ${items.length} tournaments`;
      return {
        preview: c.preview,
        label,
        reschedule: c.preview.reschedule,
        items: items.map(({ key: _k, ...i }) => i),
        local: local.map(({ key: _k, ...l }) => l),
        pins,
        scheduleOverrides,
        template,
        clear: body.clearShadowingOverrides && c.preview.template ? c.preview.template.shadowedBy : [],
      };
    },

    applyLocal(leagueId, plan, by) {
      for (const s of plan.clear) {
        if (s.source === 'schedule') {
          const o = db.select().from(tournamentScheduleOverride).where(eq(tournamentScheduleOverride.id, s.overrideId!)).get();
          if (o) db.update(tournamentScheduleOverride).set({ fields: without(o.fields as Record<string, unknown>, s.fields) }).where(eq(tournamentScheduleOverride.id, o.id)).run();
        } else {
          for (const id of s.plannedIds ?? []) {
            const r = ctx.plannedRow(leagueId, id);
            setPlanned(leagueId, id, { overrides: without(r.overrides as Record<string, unknown>, s.fields) });
          }
        }
      }
      for (const p of plan.pins) overrideRow(leagueId, p.plannedId, p.changes);
      for (const l of plan.local) overrideRow(leagueId, l.plannedId, l.changes);
      for (const o of plan.scheduleOverrides) {
        db.insert(tournamentScheduleOverride).values({ ...o, createdBy: by, createdAt: ctx.now() }).run();
      }
      if (plan.template) {
        db.update(tournamentTemplate)
          .set({ ...ctx.templateColumns(plan.template.fields as TemplatePatch), updatedAt: ctx.now() })
          .where(and(eq(tournamentTemplate.leagueId, leagueId), eq(tournamentTemplate.id, plan.template.templateId)))
          .run();
      }
      return plan.local.length;
    },

    async readItem(leagueId, item) {
      const c = ctx.connections.listActingConnections().find((x) => x.professorPlayerId === item.professorPlayerId);
      if (!c) throw new PokemonUpstreamError('not_connected', `Professor ${item.professorPlayerId}'s Pokémon account is no longer connected.`);
      if (c.status === 'needs_reconnect') throw new PokemonUpstreamError('needs_reconnect', `Reconnect ${c.professorName ?? `Professor ${item.professorPlayerId}`} in Settings.`);
      const group = ctx.connections.getStatus(leagueId).league?.id;
      if (!group) return { kind: 'fail', code: 'league_not_selected', message: 'Choose the league in Settings first.' };
      let fresh: TournamentDetails;
      try {
        fresh = await ctx.gateway(c.id).getTournament(item.tournamentId);
      } catch (err) {
        if (!(err instanceof PokemonUpstreamError) || STOPS.has(err.code)) throw err;
        if (err.code === 'not_found') return { kind: 'fail', code: 'unknown_tournament', message: 'play-tools no longer has this tournament.', connectionId: c.id };
        return { kind: 'fail', code: err.code, message: `Couldn't read the tournament first: ${err.message}`, connectionId: c.id, error: err };
      }
      const s = item.plannedId === null ? null : (ctx.settingsFor([ctx.plannedRow(leagueId, item.plannedId)]).get(item.plannedId) ?? null);
      const zone = fresh.venue?.timeZone ?? s?.venue.timeZone ?? ctx.timeZone;
      const delta = editDelta(fresh, item.changes, { fallbackZone: zone });
      if (!delta.problem && Object.keys(delta.changes).length === 0) return { kind: 'already_applied', connectionId: c.id, read: fresh };
      if (locked(fresh)) return { kind: 'fail', code: 'tournament_locked', message: "play-tools no longer lets a professor edit this tournament.", connectionId: c.id, read: fresh };
      const checked = await check(fresh, item.changes, c, group, s?.venue.country ?? DEFAULT_COUNTRY);
      if (checked.problem) return { kind: 'fail', code: checked.problem.code, message: checked.problem.message, connectionId: c.id, read: fresh };
      const current = fresh.startsAt ? dateIn(fresh.startsAt, zone) : null;
      return {
        kind: 'send',
        connectionId: c.id,
        delta: delta.changes,
        startsAt: delta.startsAt,
        localDate: item.changes.localDate ?? null,
        reschedule: item.changes.localDate !== undefined && item.changes.localDate !== current,
        read: fresh,
      };
    },

    recordEdited(leagueId, item, result) {
      if (item.plannedId !== null) overrideRow(leagueId, item.plannedId, item.changes);
      const start = result.kind === 'send' ? result.startsAt : result.read.startsAt;
      const moves = item.changes.localDate !== undefined || item.changes.startTime !== undefined || item.changes.venue !== undefined;
      if (moves && start && ctx.staffing) ctx.staffing.moveTournament(leagueId, item.tournamentId, dateIn(start, ctx.timeZone) as SessionDate);
    },

    recordReconciled(leagueId, plannedId, fresh) {
      setPlanned(leagueId, plannedId, { displayId: fresh.displayId, upstreamStatus: fresh.status });
    },

    windowProblem: (localDate) => checkCreatable(localDate, ctx.now(), ctx.timeZone),

    isShortNotice: (localDate) => isShortNotice(localDate, ctx.today()),
  };

  return {
    async editForm(leagueId, target) {
      const t = await resolve(leagueId, target);
      const r = t.upstream?.read ?? null;
      const values = r ? formValues(r, fallbackOf(t.settings, r)) : rowValues(t.row!, t.settings!);
      const isLocked = r !== null && locked(r);
      const organizerId = r?.organizerPlayerId ?? t.template!.organizerPlayerId;
      let type: EditForm['readOnly']['type'];
      if (r) type = r.series ? { kind: 'premier', seriesId: r.series.id, name: r.series.name } : { kind: 'custom' };
      else if (t.row!.seriesOverride === 'custom' || (t.row!.seriesOverride === null && t.template!.eventType === 'custom')) type = { kind: 'custom' };
      else type = { kind: 'premier', seriesId: t.row!.seriesOverride, name: null };
      let schedule: EditForm['schedule'] = null;
      if (t.schedule && t.row) {
        const scaffold = db.select().from(tournamentScaffold).where(eq(tournamentScaffold.id, t.schedule.scaffoldId)).get()!;
        const slots = db.select({ p: scaffoldSlot.position }).from(scaffoldSlot).where(eq(scaffoldSlot.scaffoldId, scaffold.id)).all().length;
        schedule = { scheduleId: t.schedule.id, slotPosition: t.row.slotPosition!, occurrenceDate: t.row.occurrenceDate!, scaffoldName: scaffold.name, siblings: slots - 1 };
      }
      return {
        target: { plannedId: t.row?.id ?? null, tournamentId: t.upstream?.tournamentId ?? null, displayId: r?.displayId ?? t.row?.displayId ?? null, inPlayTools: r !== null },
        values,
        readOnly: {
          league: { displayId: t.leagueDisplayId },
          organizer: { playerId: organizerId, name: r?.organizerName ?? acting(organizerId)?.professorName ?? null },
          product: t.template?.product ?? r?.products[0] ?? null,
          type,
        },
        editable: !isLocked,
        lockedReason: isLocked ? 'tournament_locked' : null,
        upstreamStatus: r ? (r.applicationState ?? r.status) : null,
        reschedule: r?.startsAt ? rescheduleWindow(dateIn(r.startsAt, ctx.timeZone), ctx.today()) : null,
        schedule,
        templateId: t.template?.id ?? null,
      };
    },

    async editPreview(leagueId, target, body) {
      return (await compute(leagueId, target, body)).preview;
    },

    editing,
  };
}
