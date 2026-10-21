import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, ne } from 'drizzle-orm';
import { expandSchedule, occurrenceDates } from '../../../shared/schedule/expand';
import type { PlannedInput, PlannedSeries } from '../../../shared/requirements/coverage';
import type { ScheduleRule } from '../../../shared/schedule/rule';
import type {
  EditBody,
  EditTarget,
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
import { LocalTimeError, dateIn, localDay, localInstant } from '../../../shared/time/local-time';
import type { SessionDate } from '../../../shared/types/ids';
import type { Db } from '../../db/client';
import {
  plannedTournament,
  scaffoldSlot,
  tournamentScaffold,
  tournamentSchedule,
  tournamentScheduleOverride,
  tournamentTemplate,
} from '../../db/schema';
import type { Actor } from '../accounts/service';
import type { ActingConnection, PokemonConnectionService } from '../pokemon/connection';
import { PokemonUpstreamError } from '../pokemon/ports/errors';
import type { NewTournament, PlayToolsGateway, Series, Tournament, TournamentDetails, Venue } from '../pokemon/ports/play-tools-gateway';
import type { StaffingService } from '../staffing/service';
import { type AdoptionTarget, type LeftOutReason, adoptionCandidates, isShortNotice, newTournament, selectCreateThrough } from './create';
import { addDays, addMonths, type LocalDate, timeIn } from './dates';
import { type TournamentCancelling, createCancelling } from './cancelling';
import { type EditForm, type EditPreview, type TournamentEditing, createEditing } from './editing';
import { TournamentsError } from './errors';
import { createLiveReads } from './live-reads';
import { assertMayActAs } from './organizer';
import { createListingCache } from './listing-cache';
import { type ListedTournament, type RequiredEvents, createRequiredEvents } from './required-events';
import { type TournamentRequirements, createRequirements } from './requirements';
import { tdfAvailableIn } from './results';
import { REPLANNABLE, defaultHorizonWeeks, eventKey, fitsSchedule, heldSkipped, planSchedule, type PlannedRowState } from './plan';
import { type RegistrationSettings, type SettingsOverrides, type TemplateVenue, readOverrides, readRegistration, resolveSettings } from './settings';
import { type TemplateType, type TypeResolution, offeredOn, resolveSeries } from './series';
import { type WindowProblem, checkCreatable, creatableWindow, sanctionBy } from './window';

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
  /** Admission text stored before #194 that isn't an amount; shown on the form until the template is saved. */
  legacyAdmission: string | null;
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

/** `retry_create`: an `unknown` row, a create that may have landed, sent again only by this click (#100). */
export type UpcomingAction = 'create' | 'skip' | 'unskip' | 'retry_create';

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
  /** When a create was last sent (ISO); the Retry create dialog says it may still land. */
  lastAttemptAt: string | null;
  /** Skipped while its create may have landed (#125): held until unskipped, and linked if it shows up. */
  skippedWhileUnknown: boolean;
  /** **Download TDF** would serve a file (ADR-0012 decision 7); set on Upcoming reads, from local rows only. */
  tdfAvailable: boolean;
  /** US cents, from the row's resolved on-site registration (#194); null without one, and for play-tools' own tournaments. */
  admissionCents: number | null;
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

/**
 * A tournament as a calendar event is built from it (ADR-0016 §2): a planned row, or a play-tools tournament no row
 * holds. It never carries the contact email or phone, the details, or the display id.
 */
export interface CalendarTournament {
  plannedId: number | null;
  tournamentId: string | null;
  state: PlannedRowState | 'upstream';
  /** The template's organizer for a planned row; the listing's for a play-tools one. */
  organizerPlayerId: string | null;
  /** Tokens filled; null when play-tools has none. Never a display id or GUID. */
  name: string | null;
  /** ISO; null for a row whose start a DST change skips or repeats. */
  startsAt: string | null;
  timeProblem?: LocalTimeError['reason'];
  product: string | null;
  /** The sanctioning state a listing just reported; null without one (a local read, or a tournament no listing held). */
  applicationState: string | null;
  venueLabel: string | null;
  registration: RegistrationSettings | null;
  eventWebsite: string | null;
  /** The player ID of the connection whose successful listing held the tournament; null in a local read. */
  listedBy: string | null;
}

/** What the calendar refresh read (ADR-0016 §5): the tournaments, and which professors' listings it got. */
export interface CalendarRead {
  tournaments: CalendarTournament[];
  upstream: Upcoming['upstream'] | 'local';
  /** Player IDs whose listing succeeded. */
  read: string[];
  failed: { playerId: string | null; code: string }[];
  /** A connection with no player ID was read or failed, so its tournaments can't be matched to a source. */
  unmatched: boolean;
}

/** The one details read that decides whether a tournament that dropped out of its organizer's listing is off. */
export type CalendarCheck = { kind: 'cancelled' } | { kind: 'exists'; startsAt: string | null } | { kind: 'unreadable' };

export interface TournamentsService {
  /** The league's templates by name; archived ones only when asked. */
  listTemplates(leagueId: string, opts: { archived?: boolean }): Template[];
  /** @throws TournamentsError `organizer_not_connected` */
  /** Only with one of `actor`'s own connections as organizer (ADR-0015 §4). @throws TournamentsError `organizer_not_connected`, `not_your_connection` */
  createTemplate(leagueId: string, body: TemplateBody, actor: Actor): Template;
  /** Changes only the fields given. @throws TournamentsError `not_found`, `organizer_not_connected`, `contact_required` */
  updateTemplate(leagueId: string, id: number, patch: TemplatePatch, actor: Actor): Template;
  /** Archives; never deletes. @throws TournamentsError `not_found`, `template_in_use` */
  archiveTemplate(leagueId: string, id: number, actor: Actor): void;

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
  updatePlanned(leagueId: string, id: number, patch: PlannedPatch, actor: Actor): { planned: UpcomingEntry; warnings: 'another_planned_at_time'[] };
  /**
   * Plans every schedule up to its horizon, then lists the planned tournaments and the league's play-tools ones
   * whose local date is in the range, by start. Reads play-tools as each connected professor, through the 5-minute
   * listing cache unless `refresh` (#98).
   * @throws TournamentsError `invalid_range`
   */
  upcoming(leagueId: string, range: { from?: LocalDate; to?: LocalDate; refresh?: boolean }): Promise<Upcoming>;
  /**
   * The admission (US cents) of each play-tools tournament a planned row of the league holds, resolved as Upcoming
   * shows it (#194); a tournament no row holds is left out. Local rows only: no play-tools call.
   */
  admissionsFor(leagueId: string, tournamentIds: readonly string[]): Map<string, number | null>;
  /**
   * The tournaments whose local date is in the range, for the calendar feeds (ADR-0016 §5). `refresh` plans every
   * schedule and reads each readable professor's listing fresh, as Upcoming's refresh does. `local` reads only the
   * planned rows and calls nobody.
   */
  calendarEvents(leagueId: string, range: { from: LocalDate; to: LocalDate }, mode: 'refresh' | 'local'): Promise<CalendarRead>;
  /**
   * One details read of a tournament as its organizer's connection: `cancelled` when play-tools no longer has it or
   * reports it cancelled, deleted or invalidated; `unreadable` when the read fails or nobody connected has that player ID.
   */
  checkTournament(leagueId: string, organizerPlayerId: string, tournamentId: string): Promise<CalendarCheck>;
  /** Tells the calendar the league's tournaments changed: a tournament job began or ended (ADR-0016 §5). */
  changed(leagueId: string): void;
  /**
   * A form's live choices as one professor: Custom and the premier series play-tools offers for the date (or
   * the coming 12 months), formats and venues. Each read is kept for 10 minutes.
   * @throws TournamentsError `connection_not_found`, `needs_reconnect`, `league_not_selected`; PokemonUpstreamError
   */
  options(leagueId: string, query: { professor: string; country: string; date?: LocalDate }): Promise<TournamentOptions>;
  /**
   * **Create through date…** (ADR-0010 decision 5): plans the schedule up to `through` (past its horizon if need be)
   * and lists what a create job would take, and what it leaves out. Creates nothing.
   * @throws TournamentsError `not_found`, `schedule_inactive`, `date_too_far_past`, `date_too_far_ahead`
   */
  createThrough(leagueId: string, scheduleId: number, through: LocalDate): Promise<CreateThroughPreview>;
  /** What the submission module's `tournament_create` job uses (#92), as it uses `StaffingService`. */
  creation: TournamentCreation;
  /**
   * **Edit…** (#93, ADR-0010 decision 11): the form for a planned row or a play-tools tournament, from its resolved
   * settings or a fresh read as its organizer.
   * @throws TournamentsError `not_found`, `not_editable`, `organizer_not_connected`, `needs_reconnect`, `league_not_selected`
   */
  editForm(leagueId: string, target: EditTarget): Promise<EditForm>;
  /** Every tournament an edit would touch, with before → after, leaving out those not `actor`'s to change; changes nothing. @throws TournamentsError the edit's refusals (locked, reschedule window, dates, series, format, venue, nothing to change) */
  editPreview(leagueId: string, target: EditTarget, body: EditBody, actor: Actor): Promise<EditPreview>;
  /** What the submission module's `tournament_edit` job uses (#93). */
  editing: TournamentEditing;
  /** **Cancel…** (#94, ADR-0010 decision 8): the confirm preview, and what the `tournament_cancel` job uses. */
  cancelling: TournamentCancelling;
  /** Required events (#95, ADR-0010 decision 12): what the league must hold each period, and manual covers. */
  requirements: TournamentRequirements;
  /** Required events coverage, and the listing cache a tournament job's end drops. */
  requiredEvents: RequiredEvents;
}

export interface CreateThroughPreview {
  scheduleId: number;
  scaffoldName: string;
  /** The creatable window's start. */
  from: LocalDate;
  through: LocalDate;
  tournaments: (UpcomingEntry & { shortNotice: boolean })[];
  leftOut: { entry: UpcomingEntry; reason: LeftOutReason }[];
  count: number;
  tooMany: boolean;
  suggestedThrough: LocalDate | null;
  unread: UnreadProfessor[];
}

/** A planned row a create job may take, as `prepare` found it. */
export interface CreateTarget {
  plannedId: number;
  /** The resolved name and the local date. */
  label: string;
  localDate: LocalDate;
  shortNotice: boolean;
  organizer: { playerId: string; name: string | null };
}

/** A row left out of a create because another user holds its organizer's connection (ADR-0015 §4). */
export interface CreateRefusal {
  plannedTournamentId: number;
  code: 'not_your_connection';
  professorPlayerId: string;
}

/** What adoption compares: the listing's fields, and the format from the details. */
export type CreateMatch = AdoptionTarget & { category: string };

/** What a job does with one held row: adopt a tournament play-tools has, send a create, or fail it before any write. */
export type CreatePlan =
  | { kind: 'adopt'; connectionId: number; tournamentId: string }
  | { kind: 'send'; connectionId: number; localDate: LocalDate; match: CreateMatch; tournament: NewTournament }
  | { kind: 'fail'; code: string; message: string; error?: PokemonUpstreamError; connectionId?: number };

export interface TournamentCreation {
  /**
   * The rows a create job may take, in start order, and the rows refused because another user holds their organizer's
   * connection (ADR-0015 §4). Changes nothing.
   * @throws TournamentsError `league_not_selected`, `not_found`, `not_creatable`, `date_too_far_past`, `date_too_far_ahead`,
   *   `organizer_not_connected`, `needs_reconnect`, `retry_not_confirmed`, `short_notice_not_acknowledged`, and
   *   `not_your_connection` when no row is the actor's
   */
  prepare(
    leagueId: string,
    plannedIds: readonly number[],
    opts: { retryUnknown: boolean; acknowledgeShortNotice: boolean },
    actor: Actor,
  ): { targets: CreateTarget[]; refused: CreateRefusal[] };
  /** Rows a job takes become `creating`, so no replan deletes them. Call inside the job's transaction. */
  hold(leagueId: string, plannedIds: readonly number[]): void;
  /**
   * Settings, adoption, series and venue for one held row, as its organizer. Reads only.
   * @throws PokemonUpstreamError `not_connected`, `needs_reconnect`, `forbidden`: the job stops
   */
  planItem(leagueId: string, plannedId: number): Promise<CreatePlan>;
  /** A tournament matching a create that may have landed (adoption only). @throws PokemonUpstreamError when play-tools can't be read */
  findLanded(leagueId: string, connectionId: number, match: CreateMatch): Promise<string | null>;
  /** Null when the date is still in the creatable window, by this module's clock. */
  windowProblem(localDate: LocalDate): WindowProblem | null;
  recordSent(leagueId: string, plannedId: number, at: Date): void;
  recordCreated(leagueId: string, plannedId: number, tournamentId: string): void;
  recordReconciled(leagueId: string, plannedId: number, read: { displayId: string | null; status: string | null }): void;
  recordUnknown(leagueId: string, plannedId: number): void;
  recordFailed(leagueId: string, plannedId: number, code: string): void;
  /** A held row the job never sent: `unknown` when an earlier attempt was sent, else `planned`. */
  release(leagueId: string, plannedId: number): void;
  /** Of these rows, the ones still `planned` or `failed`, in the order given: what a retry takes. */
  retryable(leagueId: string, plannedIds: readonly number[]): number[];
  /** A create-through job succeeded: the schedule is in play-tools through `date`, never moved back. */
  recordCreatedThrough(leagueId: string, scheduleId: number, date: LocalDate): void;
}

export interface TournamentOptions {
  types: (
    | { kind: 'custom' }
    | { kind: 'premier'; seriesId: string; name: string; product: string; categories: string[]; window: { from: LocalDate; to: LocalDate } }
  )[];
  formats: { product: string; categories: string[] }[];
  venues: { id: string; label: string; country: string | null; timeZone: string | null }[];
}

/** Where Upcoming's listings come from: the shared cache, a fresh read kept in it, or play-tools without the cache. */
type ListingMode = 'cached' | 'refresh' | 'live';

/** The play-tools reads this module makes, as one professor. */
export type TournamentsGateway = Pick<PlayToolsGateway, 'listTournaments' | 'getTournament' | 'listTournamentParticipants' | 'listSeries' | 'listFormats' | 'listVenues'>;

export interface TournamentsDeps {
  db: Db;
  connections: Pick<PokemonConnectionService, 'league' | 'listActingConnections' | 'listReadableConnections' | 'actingConnection'>;
  /** Play-tools as one professor's connection. */
  gateway: (connectionId: number) => TournamentsGateway;
  /** A rescheduled tournament's staff move with it, and a cancelled one's are dropped or tombstoned (ADR-0010 decision 8). */
  staffing?: Pick<StaffingService, 'moveTournament' | 'cancelTournament'>;
  /** The league time zone (ADR-0006): the creatable window and Upcoming's dates are in it. */
  timeZone: string;
  now?: () => Date;
  /**
   * Called after a write that changes the league's planned rows or their templates commits, so the calendar rebuilds
   * its local part (ADR-0016 §5). Not awaited; a failure never fails the write.
   */
  onTournamentsChanged?: (leagueId: string) => Promise<void> | void;
}

/** Statuses play-tools' listing drops: a tournament with one of them is off. */
const GONE_STATUSES = new Set(['cancelled', 'deleted', 'invalidated']);

/**
 * The writes after which the calendar rebuilds (ADR-0016 §5). A new write method that changes planned rows, or what
 * they show, belongs here. Creating a template or a scaffold changes no row; tournament jobs are reported by the
 * submission module through `changed`.
 */
const CHANGING_METHODS = [
  'updateTemplate', // a row shows its template's name, venue, registration and website
  'archiveTemplate',
  'updateScaffold', // replans its schedules' rows
  'archiveScaffold',
  'createSchedule', // plans rows
  'updateSchedule', // replans rows
  'archiveSchedule', // deletes rows not in play-tools
  'createPlanned',
  'updatePlanned', // skip, unskip, move
  'createThrough', // plans rows up to the date before it previews them
] as const satisfies readonly (keyof TournamentsService)[];

type TemplateRow = typeof tournamentTemplate.$inferSelect;
type ScheduleRow = typeof tournamentSchedule.$inferSelect;
type PlannedRow = typeof plannedTournament.$inferSelect;
/** A row's own date or time, kept across replans, and settings set on it before creation. */
type RowOverrides = SettingsOverrides & { localDate?: LocalDate };

/** Upcoming's default reach: the longest horizon. */
const UPCOMING_DAYS = 26 * 7;
/** Upcoming's longest range, so a year of planned tournaments fits. */
const MAX_UPCOMING_DAYS = 366;

/** The country a venue takes when play-tools leaves it out, as the form stores it (`venueValue`, Update #91). */
const VENUE_COUNTRY_FALLBACK = 'US';

/** How far ahead a preview looks: the recurrence engine's longest range. */
const PREVIEW_DAYS = 400;

/** Planned rows coverage counts while they aren't in play-tools (#95). */
const COUNTED: ReadonlySet<PlannedRowState> = new Set(['planned', 'creating', 'failed', 'unknown']);

/** Upstream errors that mean the organizer can't act at all: a create job stops (ADR-0010 decision 5). */
const STOPS: ReadonlySet<string> = new Set(['forbidden', 'needs_reconnect', 'not_connected']);

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
      ...readRegistration(r.registration),
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

  /** A template's organizer is one of `actor`'s own connections, whatever its status: a reconnect doesn't change who they are. */
  const requireOrganizer = (actor: Actor, playerId: string) => assertMayActAs(deps.connections, actor, playerId, { local: true });

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
  const live = createLiveReads({ gateway: deps.gateway, now });
  /** Each professor's listing, shared by coverage and Upcoming (ADR-0010 Update #95 item 8, #98). */
  const listings = createListingCache({ gateway: deps.gateway, now });

  function scheduleActive(schedule: ScheduleRow): boolean {
    if (schedule.paused || schedule.archivedAt) return false;
    return !db.select({ archivedAt: tournamentScaffold.archivedAt }).from(tournamentScaffold).where(eq(tournamentScaffold.id, schedule.scaffoldId)).get()?.archivedAt;
  }

  /** Brings one schedule's rows in line with it (ADR-0010 decision 4): see `planSchedule`. */
  function syncSchedule(leagueId: string, schedule: ScheduleRow, through?: LocalDate) {
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
        overrides: readOverrides(r.overrides) as RowOverrides,
        skippedWhileUnknown: r.skippedWhileUnknown,
      })),
      today: today(),
      windowStart: creatableWindow(now(), deps.timeZone).from,
      takenElsewhere,
      ...(through !== undefined && { through }),
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
    schedules: Map<number, ScheduleRow & { rule: ScheduleRule; active: boolean; positions: Set<number> }>;
    overrides: (typeof tournamentScheduleOverride.$inferSelect)[];
    conns: readonly ActingConnection[];
    /** Each organizer's series by player id: null when the read failed; absent when not read. */
    series: Map<string, readonly Series[] | null>;
  }

  function admissionOf(registration: RegistrationSettings): number | null {
    return registration.kind === 'on_site' ? registration.admissionCents : null;
  }

  function contextFor(rows: readonly PlannedRow[]): EntryContext {
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
            rule: s.rule as ScheduleRule,
            active: scheduleActive(s),
            positions: new Set(db.select({ p: scaffoldSlot.position }).from(scaffoldSlot).where(eq(scaffoldSlot.scaffoldId, s.scaffoldId)).all().map((x) => x.p)),
          },
        ]),
      ),
      overrides: scheduleIds.length === 0 ? [] : db.select().from(tournamentScheduleOverride).where(inArray(tournamentScheduleOverride.scheduleId, scheduleIds)).all(),
      conns: deps.connections.listActingConnections(),
      series: new Map(),
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
    // The resolved venue's country, as creation takes it: a one-off may have its own venue (#162).
    const country = settingsOf(row, ctx).venue.country;
    return resolveSeries({ type, product: template.product, country, date: row.localDate, pick }, list);
  }

  /** A row's settings as it would be created now: template, schedule overrides in effect, its own (decision 11). */
  function settingsOf(row: PlannedRow, ctx: EntryContext) {
    const scheduleOverrides = ctx.overrides
      .filter((o) => o.scheduleId === row.scheduleId && o.slotPosition === row.slotPosition)
      .map((o) => ({ effectiveFrom: o.effectiveFrom, fields: readOverrides(o.fields) }));
    return resolveSettings(templateView(ctx.templates.get(row.templateId)!), scheduleOverrides, readOverrides(row.overrides), {
      occurrenceDate: row.occurrenceDate ?? row.localDate,
      localDate: row.localDate,
    });
  }

  function entryOf(row: PlannedRow, ctx: EntryContext): UpcomingEntry {
    const template = ctx.templates.get(row.templateId)!;
    const schedule = row.scheduleId === null ? undefined : ctx.schedules.get(row.scheduleId);
    const settings = settingsOf(row, ctx);
    let startsAt: string | null = null;
    let timeProblem: LocalTimeError['reason'] | undefined;
    try {
      startsAt = localInstant(row.localDate, row.startTime, settings.venue.timeZone).toISOString();
    } catch (err) {
      if (!(err instanceof LocalTimeError)) throw err;
      timeProblem = err.reason;
    }
    const organizer = organizerOf(template.organizerPlayerId, ctx.conns);
    const type = typeFor(row, template, ctx);
    const toCreate = row.state === 'planned' || row.state === 'failed';
    const actable = organizer.connected && startsAt !== null && checkCreatable(row.localDate, now(), deps.timeZone) === null;
    const creatable = toCreate && actable && type !== null && (type.kind === 'custom' || type.status === 'resolved');
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
      lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
      skippedWhileUnknown: heldSkipped(row),
      tdfAvailable: false,
      admissionCents: admissionOf(settings.registration),
      actions: [
        ...(creatable ? (['create'] as const) : []),
        ...(toCreate || row.state === 'unknown' ? (['skip'] as const) : []),
        ...(row.state === 'skipped' ? (['unskip'] as const) : []),
        ...(row.state === 'unknown' && actable ? (['retry_create'] as const) : []),
      ],
    };
  }

  /**
   * The league's tournaments starting in the range, as each connected professor (they list only their own,
   * ADR-0009), one call each. A professor who can't be read is named; the rest still count.
   */
  async function listLeagueTournaments(conns: readonly ActingConnection[], group: string, from: LocalDate, to: LocalDate, mode: ListingMode) {
    const range = { from: localDay(from as SessionDate, deps.timeZone).from, to: localDay(to as SessionDate, deps.timeZone).to };
    const tournaments: { tournament: Tournament; organizer: ActingConnection }[] = [];
    const unread: UnreadProfessor[] = [];
    const seen = new Set<string>();
    for (const c of conns) {
      const professor = { playerId: c.professorPlayerId, name: c.professorName };
      if (c.status === 'needs_reconnect') {
        unread.push({ professor, code: 'needs_reconnect', message: `Reconnect ${c.professorName ?? 'this professor'} in Settings to see their tournaments.` });
        continue;
      }
      try {
        const listing = mode === 'live' ? deps.gateway(c.id).listTournaments(range) : listings.read(c.id, range, { refresh: mode === 'refresh' });
        for (const t of await listing) {
          if (t.groupId !== group || t.startsAt === null || seen.has(t.id)) continue;
          seen.add(t.id);
          tournaments.push({ tournament: t, organizer: c });
        }
      } catch (err) {
        if (!(err instanceof PokemonUpstreamError)) throw err;
        unread.push({ professor, code: err.code, message: err.message });
      }
    }
    return { tournaments, unread };
  }

  /** Each organizer's series, for the rows whose type needs them: null when they can't be read. */
  async function seriesByOrganizer(
    rows: readonly PlannedRow[],
    templates: ReadonlyMap<number, TemplateRow>,
    conns: readonly ActingConnection[],
    group: string | null,
  ) {
    const needing = new Set<string>();
    for (const r of rows) {
      const t = templates.get(r.templateId)!;
      const resolvable = REPLANNABLE.has(r.state) || r.state === 'creating' || r.state === 'unknown';
      if (resolvable && r.seriesOverride !== 'custom' && (r.seriesOverride !== null || t.eventType === 'premier')) needing.add(t.organizerPlayerId);
    }
    const series = new Map<string, readonly Series[] | null>();
    for (const playerId of needing) {
      const c = conns.find((x) => x.professorPlayerId === playerId && x.status === 'connected');
      if (!c || group === null) {
        series.set(playerId, null);
        continue;
      }
      try {
        series.set(playerId, await live.series(c.id, group));
      } catch (err) {
        if (!(err instanceof PokemonUpstreamError)) throw err;
        series.set(playerId, null);
      }
    }
    return series;
  }

  /** A play-tools tournament no planned row holds. */
  function upstreamEntry(t: Tournament, organizer: OrganizerView): UpcomingEntry {
    const localDate = dateIn(t.startsAt!, deps.timeZone);
    return {
      plannedId: null,
      tournamentId: t.id,
      scheduleId: null,
      slotPosition: null,
      occurrenceDate: null,
      templateId: null,
      name: t.name ?? t.displayId ?? t.id,
      localDate,
      startTime: timeIn(t.startsAt!, deps.timeZone),
      startsAt: t.startsAt!.toISOString(),
      sanctionBy: sanctionBy(localDate),
      state: 'upstream',
      inSchedule: null,
      organizer,
      product: t.products.length === 1 ? t.products[0]! : null,
      category: null,
      type: null,
      displayId: t.displayId,
      upstreamStatus: t.status,
      errorCode: null,
      lastAttemptAt: null,
      skippedWhileUnknown: false,
      tdfAvailable: false,
      admissionCents: null,
      actions: [],
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

  /** Planned rows in the range (already materialised) merged with the league's play-tools tournaments, by start. */
  async function read(leagueId: string, from: LocalDate, to: LocalDate, mode: ListingMode): Promise<Upcoming> {
    const rowsIn = () =>
      db
        .select()
        .from(plannedTournament)
        .where(and(eq(plannedTournament.leagueId, leagueId), gte(plannedTournament.localDate, from), lte(plannedTournament.localDate, to)))
        .all();
    let rows = rowsIn();
    const conns = deps.connections.listReadableConnections();
    const group = conns.length === 0 ? null : (deps.connections.league(leagueId)?.id ?? null);
    const status = conns.length === 0 ? 'not_connected' : group === null ? 'league_not_selected' : 'read';
    const listed = group === null ? { tournaments: [], unread: [] } : await listLeagueTournaments(conns, group, from, to, mode);
    if (group !== null && (await linkUnknown(leagueId, group, rows, listed.tournaments))) rows = rowsIn();
    const ctx = contextFor(rows);
    ctx.series = await seriesByOrganizer(rows, ctx.templates, conns, group);

    const byId = new Map(listed.tournaments.map((l) => [l.tournament.id, l.tournament]));
    const linked = new Set(
      listed.tournaments.length === 0
        ? []
        : db
            .select({ id: plannedTournament.tournamentId })
            .from(plannedTournament)
            .where(and(eq(plannedTournament.leagueId, leagueId), inArray(plannedTournament.tournamentId, [...byId.keys()])))
            .all()
            .map((r) => r.id),
    );
    const planned = rows.map((r) => {
      const entry = entryOf(r, ctx);
      const upstreamOne = r.tournamentId === null ? undefined : byId.get(r.tournamentId);
      return upstreamOne ? { ...entry, displayId: upstreamOne.displayId ?? entry.displayId, upstreamStatus: upstreamOne.status } : entry;
    });
    const others = listed.tournaments
      .filter((l) => !linked.has(l.tournament.id))
      .map((l) => upstreamEntry(l.tournament, organizerOf(l.organizer.professorPlayerId!, conns)))
      .filter((e) => e.localDate >= from && e.localDate <= to);
    const withTdf = tdfAvailableIn(
      db,
      leagueId,
      [...planned, ...others].flatMap((e) => (e.tournamentId === null ? [] : [e.tournamentId])),
    );
    const tournaments = [...planned, ...others]
      .map((e) => (e.tournamentId !== null && withTdf.has(e.tournamentId) ? { ...e, tdfAvailable: true } : e))
      .sort(
        (a, b) => a.localDate.localeCompare(b.localDate) || (a.startsAt ?? a.startTime).localeCompare(b.startsAt ?? b.startTime) || (a.plannedId ?? 0) - (b.plannedId ?? 0),
      );
    return { timeZone: deps.timeZone, from, to, tournaments, upstream: status, unread: listed.unread };
  }

  /** Every play-tools guid a planned row of the league holds: adoption never takes one (#100). */
  function linkedGuids(leagueId: string): Set<string> {
    return new Set(
      db
        .select({ id: plannedTournament.tournamentId })
        .from(plannedTournament)
        .where(and(eq(plannedTournament.leagueId, leagueId), isNotNull(plannedTournament.tournamentId)))
        .all()
        .map((r) => r.id!),
    );
  }

  /** The candidate whose details have the same format, or null. A failed details read throws: it can't rule a match out. */
  async function pickByFormat(connectionId: number, candidates: readonly Tournament[], category: string) {
    for (const t of candidates) {
      const details = await deps.gateway(connectionId).getTournament(t.id);
      if (details.category === category) return details;
    }
    return null;
  }

  /** The organizer's tournament a create would duplicate (ADR-0010 decision 5), from a fresh listing at its start. */
  async function findMatch(leagueId: string, connectionId: number, match: CreateMatch): Promise<string | null> {
    const listed = await deps.gateway(connectionId).listTournaments({ from: match.startsAt, to: new Date(match.startsAt.getTime() + 1) });
    const found = await pickByFormat(connectionId, adoptionCandidates(match, listed, linkedGuids(leagueId)), match.category);
    return found?.id ?? null;
  }

  /**
   * Links `unknown` rows (a create that may have landed) to a tournament the listing already holds (#100): no write,
   * and one details read per candidate, for its format. A row whose candidate can't be read stays unknown.
   * Returns whether any row was linked.
   */
  async function linkUnknown(
    leagueId: string,
    group: string,
    rows: readonly PlannedRow[],
    listed: readonly { tournament: Tournament; organizer: ActingConnection }[],
  ): Promise<boolean> {
    const unknown = rows.filter((r) => r.tournamentId === null && (r.state === 'unknown' || heldSkipped(r)));
    if (unknown.length === 0 || listed.length === 0) return false;
    const ctx = contextFor(unknown);
    let any = false;
    for (const row of unknown) {
      const template = ctx.templates.get(row.templateId)!;
      const settings = settingsOf(row, ctx);
      let startsAt: Date;
      try {
        startsAt = localInstant(row.localDate, row.startTime, settings.venue.timeZone);
      } catch (err) {
        if (err instanceof LocalTimeError) continue;
        throw err;
      }
      const theirs = listed.filter((l) => l.organizer.professorPlayerId === template.organizerPlayerId);
      if (theirs.length === 0) continue;
      const target = { startsAt, product: template.product, name: settings.name, groupId: group };
      const candidates = adoptionCandidates(target, theirs.map((l) => l.tournament), linkedGuids(leagueId));
      try {
        const found = await pickByFormat(theirs[0]!.organizer.id, candidates, settings.category);
        if (!found) continue;
        if (linkLanded(leagueId, row.id, found)) any = true;
      } catch (err) {
        if (!(err instanceof PokemonUpstreamError)) throw err;
      }
    }
    return any;
  }

  /**
   * Links a row to the tournament its create made, as the row is now, not as it was before the details read (#125):
   * `unknown` becomes `created`, a held skipped row stays skipped, and anything else (a job took it, it was linked)
   * is left alone. A tournament another row took meanwhile isn't linked twice. No await, so nothing changes between
   * the check and the write.
   */
  function linkLanded(leagueId: string, id: number, found: TournamentDetails): boolean {
    if (linkedGuids(leagueId).has(found.id)) return false;
    const row = plannedRow(leagueId, id);
    if (row.tournamentId !== null || !(row.state === 'unknown' || heldSkipped(row))) return false;
    setPlanned(leagueId, id, {
      state: row.state === 'unknown' ? 'created' : row.state,
      tournamentId: found.id,
      displayId: found.displayId,
      upstreamStatus: found.applicationState ?? found.status,
      errorCode: null,
    });
    return true;
  }

  /** The organizer's connection, if they can act; a job stops otherwise. */
  function actingAs(playerId: string): ActingConnection {
    const c = deps.connections.listActingConnections().find((x) => x.professorPlayerId === playerId);
    if (!c) throw new PokemonUpstreamError('not_connected', `Professor ${playerId}'s Pokémon account is no longer connected.`);
    if (c.status === 'needs_reconnect') throw new PokemonUpstreamError('needs_reconnect', `Reconnect ${c.professorName ?? `Professor ${playerId}`} in Settings.`);
    return c;
  }

  /**
   * Skip or unskip a row whose create may have landed (#125). Nothing else changes on it: the create may land under
   * its current date, time and series. Unskipping gives `created` once it was linked, else `unknown` again.
   */
  function updateUnsettled(row: PlannedRow, patch: PlannedPatch) {
    const moves = patch.localDate !== undefined || patch.startTime !== undefined || patch.seriesId !== undefined;
    let set: Partial<typeof plannedTournament.$inferInsert> = {};
    if (row.state === 'unknown') {
      if (moves || patch.skipped !== true) {
        throw new TournamentsError('not_editable', 'This tournament may have been created in play-tools. Skip it, or retry the create.', { state: 'unknown' });
      }
      set = { state: 'skipped', skippedWhileUnknown: true };
    } else {
      if (moves) {
        throw new TournamentsError('not_editable', 'This tournament may be in play-tools. Unskip it first.', { state: 'skipped', skippedWhileUnknown: true });
      }
      if (patch.skipped === false) set = { state: row.tournamentId ? 'created' : 'unknown', skippedWhileUnknown: false };
    }
    const updated = Object.keys(set).length === 0 ? row : db.update(plannedTournament).set(set).where(eq(plannedTournament.id, row.id)).returning().get();
    return { planned: entryOf(updated, contextFor([updated])), warnings: [] };
  }

  function setPlanned(leagueId: string, id: number, set: Partial<typeof plannedTournament.$inferInsert>) {
    db.update(plannedTournament)
      .set(set)
      .where(and(eq(plannedTournament.leagueId, leagueId), eq(plannedTournament.id, id)))
      .run();
  }

  const creation: TournamentCreation = {
    prepare(leagueId, plannedIds, opts, actor) {
      const group = deps.connections.league(leagueId)?.id;
      if (!group) throw new TournamentsError('league_not_selected', 'Choose the league in Settings first.');
      const rows = db
        .select()
        .from(plannedTournament)
        .where(and(eq(plannedTournament.leagueId, leagueId), inArray(plannedTournament.id, [...plannedIds])))
        .all();
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const id of plannedIds) {
        if (!byId.has(id)) throw new TournamentsError('not_found', `No planned tournament ${id}.`, { plannedTournamentId: id });
      }
      const ctx = contextFor(rows);
      const refused: CreateRefusal[] = [];
      for (const id of plannedIds) {
        const row = byId.get(id)!;
        if (!(row.state === 'planned' || row.state === 'failed' || row.state === 'unknown')) {
          throw new TournamentsError('not_creatable', 'This tournament is in play-tools, skipped, cancelled, or being created already.', {
            plannedTournamentId: id,
            state: row.state,
          });
        }
        const problem = checkCreatable(row.localDate, now(), deps.timeZone);
        if (problem) {
          const message = problem === 'date_too_far_past' ? `${row.localDate} is too far back to create.` : `${row.localDate} is more than 12 months ahead.`;
          throw new TournamentsError(problem, message, { plannedTournamentId: id });
        }
        const organizer = ctx.templates.get(row.templateId)!.organizerPlayerId;
        const c = ctx.conns.find((x) => x.professorPlayerId === organizer);
        if (!c) {
          throw new TournamentsError('organizer_not_connected', `Professor ${organizer} isn't connected. Connect their Pokémon account in Settings.`, {
            plannedTournamentId: id,
            professorPlayerId: organizer,
          });
        }
        if (c.userId !== actor.userId) {
          refused.push({ plannedTournamentId: id, code: 'not_your_connection', professorPlayerId: organizer });
          continue;
        }
        if (c.status === 'needs_reconnect') {
          throw new TournamentsError('needs_reconnect', `Reconnect ${c.professorName ?? `Professor ${organizer}`} in Settings.`, {
            plannedTournamentId: id,
            professorPlayerId: organizer,
          });
        }
        // The pokemon module has the last word on who may act as this organizer.
        assertMayActAs(deps.connections, actor, organizer);
      }
      if (refused.length === plannedIds.length) {
        throw new TournamentsError('not_your_connection', 'Only the professors who organize these tournaments can create them.', {
          professorPlayerId: refused[0]!.professorPlayerId,
          refused,
        });
      }
      const taken = plannedIds.filter((id) => !refused.some((r) => r.plannedTournamentId === id));
      const unknown = taken.filter((id) => byId.get(id)!.state === 'unknown');
      if (unknown.length > 0 && !opts.retryUnknown) {
        throw new TournamentsError('retry_not_confirmed', 'An earlier create may still appear in play-tools. Confirm to try again.', {
          plannedTournamentIds: unknown,
        });
      }
      const short = taken.filter((id) => isShortNotice(byId.get(id)!.localDate, today()));
      if (short.length > 0 && !opts.acknowledgeShortNotice) {
        throw new TournamentsError('short_notice_not_acknowledged', 'Some are less than 7 days away; the league is expected to sanction 7 days ahead.', {
          plannedTournamentIds: short,
        });
      }
      const targets = rows
        .filter((r) => taken.includes(r.id))
        .map((r) => entryOf(r, ctx))
        .sort((a, b) => a.localDate.localeCompare(b.localDate) || (a.startsAt ?? a.startTime).localeCompare(b.startsAt ?? b.startTime) || a.plannedId! - b.plannedId!)
        .map((e) => ({
          plannedId: e.plannedId!,
          label: `${e.name} · ${e.localDate}`,
          localDate: e.localDate,
          shortNotice: isShortNotice(e.localDate, today()),
          organizer: { playerId: e.organizer!.playerId, name: e.organizer!.name },
        }));
      return { targets, refused };
    },

    hold(leagueId, plannedIds) {
      db.update(plannedTournament)
        .set({ state: 'creating' })
        .where(and(eq(plannedTournament.leagueId, leagueId), inArray(plannedTournament.id, [...plannedIds])))
        .run();
    },

    async planItem(leagueId, plannedId) {
      const row = plannedRow(leagueId, plannedId);
      const ctx = contextFor([row]);
      const template = ctx.templates.get(row.templateId)!;
      const settings = settingsOf(row, ctx);
      let startsAt: Date;
      try {
        startsAt = localInstant(row.localDate, row.startTime, settings.venue.timeZone);
      } catch (err) {
        if (!(err instanceof LocalTimeError)) throw err;
        return { kind: 'fail', code: 'start_time_invalid', message: `${row.startTime} on ${row.localDate} is skipped or repeated by a clock change.` };
      }
      const c = actingAs(template.organizerPlayerId);
      const group = deps.connections.league(leagueId)?.id;
      if (!group) return { kind: 'fail', code: 'league_not_selected', message: 'Choose the league in Settings first.' };
      const match: CreateMatch = { startsAt, product: template.product, name: settings.name, groupId: group, category: settings.category };

      let adopted: string | null;
      try {
        adopted = await findMatch(leagueId, c.id, match);
      } catch (err) {
        if (!(err instanceof PokemonUpstreamError) || STOPS.has(err.code)) throw err;
        return { kind: 'fail', code: 'listing_unavailable', message: `Couldn't check play-tools for this tournament first: ${err.message}`, error: err, connectionId: c.id };
      }
      if (adopted) return { kind: 'adopt', connectionId: c.id, tournamentId: adopted };
      // A one-off's override, then a template edit, can leave it with no contact (#162); play-tools needs one.
      if (settings.contactEmail === null && settings.contactPhone === null) {
        return { kind: 'fail', code: 'contact_required', message: 'Give this tournament a contact email or phone.' };
      }

      let seriesId: string | null = null;
      const premier = row.seriesOverride !== 'custom' && (row.seriesOverride !== null || template.eventType === 'premier');
      if (premier) {
        let list: readonly Series[];
        try {
          list = await live.series(c.id, group);
        } catch (err) {
          if (!(err instanceof PokemonUpstreamError) || STOPS.has(err.code)) throw err;
          return { kind: 'fail', code: 'series_unavailable', message: `Couldn't read play-tools' series: ${err.message}`, error: err, connectionId: c.id };
        }
        const type: TemplateType = template.eventType === 'premier' ? { kind: 'premier', seriesMatch: template.seriesMatch ?? '' } : { kind: 'custom' };
        const resolved = resolveSeries({ type, product: template.product, country: settings.venue.country, date: row.localDate, pick: row.seriesOverride }, list);
        if (resolved.kind === 'premier') {
          if (resolved.status !== 'resolved') {
            return { kind: 'fail', code: resolved.status, message: `No single play-tools series for ${row.localDate}: pick the type on this tournament.` };
          }
          seriesId = resolved.series.id;
          if (!list.find((x) => x.id === seriesId)!.categories.includes(settings.category)) {
            return { kind: 'fail', code: 'format_not_in_series', message: `${resolved.series.name} doesn't offer the format ${settings.category}.` };
          }
        }
      }
      let venues: readonly Venue[];
      try {
        venues = await live.venues(c.id, group, settings.venue.country);
      } catch (err) {
        if (!(err instanceof PokemonUpstreamError) || STOPS.has(err.code)) throw err;
        return { kind: 'fail', code: 'venue_unavailable', message: `Couldn't read the organizer's venues: ${err.message}`, error: err, connectionId: c.id };
      }
      const listed = venues.find((v) => v.id === settings.venue.id);
      if (!listed) {
        return { kind: 'fail', code: 'venue_not_found', message: `${settings.venue.label} is no longer in the organizer's address book. Pick another venue on the template.` };
      }
      // The start instant and the series window come from the stored zone and country, which the browser sent
      // (#162): play-tools' own entry must agree. Where play-tools leaves either out, the form stores the league's
      // zone and `US` (`venueValue`), so that is what it must be.
      if ((listed.timeZone ?? deps.timeZone) !== settings.venue.timeZone || (listed.country ?? VENUE_COUNTRY_FALLBACK) !== settings.venue.country) {
        const own = settings.venue.id !== template.venueId || settings.venue.timeZone !== template.venueTimeZone || settings.venue.country !== template.venueCountry;
        return {
          kind: 'fail',
          code: 'venue_not_found',
          message: `${settings.venue.label} has changed in the organizer's address book. Pick the venue again on ${own ? 'this tournament' : 'the template'}.`,
        };
      }
      return {
        kind: 'send',
        connectionId: c.id,
        localDate: row.localDate,
        match,
        tournament: newTournament(settings, { startsAt, groupId: group, product: template.product, seriesId }),
      };
    },

    findLanded: (leagueId, connectionId, match) => findMatch(leagueId, connectionId, match),

    windowProblem: (localDate) => checkCreatable(localDate, now(), deps.timeZone),

    recordSent(leagueId, plannedId, at) {
      setPlanned(leagueId, plannedId, { lastAttemptAt: at });
    },
    recordCreated(leagueId, plannedId, tournamentId) {
      setPlanned(leagueId, plannedId, { state: 'created', tournamentId, errorCode: null });
    },
    recordReconciled(leagueId, plannedId, fresh) {
      setPlanned(leagueId, plannedId, { displayId: fresh.displayId, upstreamStatus: fresh.status });
    },
    recordUnknown(leagueId, plannedId) {
      setPlanned(leagueId, plannedId, { state: 'unknown', errorCode: null });
    },
    recordFailed(leagueId, plannedId, code) {
      setPlanned(leagueId, plannedId, { state: 'failed', errorCode: code });
    },
    release(leagueId, plannedId) {
      setPlanned(leagueId, plannedId, { state: plannedRow(leagueId, plannedId).lastAttemptAt ? 'unknown' : 'planned' });
    },
    retryable(leagueId, plannedIds) {
      if (plannedIds.length === 0) return [];
      const open = new Set(
        db
          .select({ id: plannedTournament.id })
          .from(plannedTournament)
          .where(and(eq(plannedTournament.leagueId, leagueId), inArray(plannedTournament.id, [...plannedIds]), inArray(plannedTournament.state, ['planned', 'failed'])))
          .all()
          .map((r) => r.id),
      );
      return plannedIds.filter((id) => open.has(id));
    },
    recordCreatedThrough(leagueId, scheduleId, date) {
      const row = scheduleRow(leagueId, scheduleId);
      if (row.createdThrough === null || row.createdThrough < date) {
        db.update(tournamentSchedule).set({ createdThrough: date }).where(eq(tournamentSchedule.id, scheduleId)).run();
      }
    },
  };

  const edits = createEditing({
    db,
    connections: deps.connections,
    gateway: deps.gateway,
    live,
    ...(deps.staffing && { staffing: deps.staffing }),
    timeZone: deps.timeZone,
    now,
    today,
    plannedRow,
    settingsFor(rows) {
      const ctx = contextFor(rows);
      return new Map(rows.map((r) => [r.id, settingsOf(r, ctx)]));
    },
    rowAt,
    templateColumns: (t) => templateColumns(t),
  });

  const cancelling = createCancelling({
    db,
    connections: deps.connections,
    gateway: deps.gateway,
    ...(deps.staffing && { staffing: deps.staffing }),
    timeZone: deps.timeZone,
    now,
    plannedRow,
  });

  const requirements = createRequirements({ db, now });

  /** Planned rows coverage counts: not in play-tools yet, from the creatable window on (ADR-0010 decision 12, #95). */
  async function plannedForCoverage(
    leagueId: string,
    to: LocalDate,
    group: string | null,
    listed: readonly ListedTournament[],
    opts: { link: boolean },
  ): Promise<PlannedInput[]> {
    materialise(leagueId);
    const from = creatableWindow(now(), deps.timeZone).from;
    const rowsIn = () =>
      db
        .select()
        .from(plannedTournament)
        .where(and(eq(plannedTournament.leagueId, leagueId), gte(plannedTournament.localDate, addDays(from, -1)), lte(plannedTournament.localDate, addDays(to, 1))))
        .all();
    let rows = rowsIn();
    if (opts.link && group !== null && (await linkUnknown(leagueId, group, rows, listed))) rows = rowsIn();
    rows = rows.filter((r) => r.tournamentId === null && COUNTED.has(r.state));
    const ctx = contextFor(rows);
    ctx.series = await seriesByOrganizer(rows, ctx.templates, ctx.conns, group);
    return rows.flatMap((row): PlannedInput[] => {
      const template = ctx.templates.get(row.templateId)!;
      const settings = settingsOf(row, ctx);
      let localDate = row.localDate;
      try {
        localDate = dateIn(localInstant(row.localDate, row.startTime, settings.venue.timeZone), deps.timeZone);
      } catch (err) {
        if (!(err instanceof LocalTimeError)) throw err;
      }
      if (localDate < from) return [];
      const type = typeFor(row, template, ctx);
      const series: PlannedSeries =
        type === null || type.kind === 'custom'
          ? { kind: 'none' }
          : type.status === 'resolved'
            ? { kind: 'resolved', name: type.series.name }
            : type.status === 'unavailable'
              ? row.seriesOverride === null
                ? { kind: 'fallback', match: template.seriesMatch ?? '' }
                : { kind: 'unjudged' }
              : { kind: 'none' };
      const organizer = organizerOf(template.organizerPlayerId, ctx.conns);
      return [{ plannedId: row.id, localDate, product: template.product, series, organizer: { playerId: organizer.playerId, name: organizer.name } }];
    });
  }

  const requiredEvents = createRequiredEvents({
    connections: deps.connections,
    gateway: deps.gateway,
    listings,
    live,
    requirements,
    planned: plannedForCoverage,
    timeZone: deps.timeZone,
    now,
  });

  const service: TournamentsService = {
    ...edits,
    cancelling,
    requirements,
    requiredEvents,

    admissionsFor(leagueId, tournamentIds) {
      if (tournamentIds.length === 0) return new Map();
      const rows = db
        .select()
        .from(plannedTournament)
        .where(and(eq(plannedTournament.leagueId, leagueId), inArray(plannedTournament.tournamentId, [...tournamentIds])))
        .all();
      const ctx = contextFor(rows);
      return new Map(rows.map((r) => [r.tournamentId!, admissionOf(settingsOf(r, ctx).registration)]));
    },

    listTemplates(leagueId, opts) {
      const rows = db
        .select()
        .from(tournamentTemplate)
        .where(and(eq(tournamentTemplate.leagueId, leagueId), opts.archived ? undefined : isNull(tournamentTemplate.archivedAt)))
        .orderBy(asc(tournamentTemplate.name), asc(tournamentTemplate.id))
        .all();
      return rows.map(templateView);
    },

    createTemplate(leagueId, body, actor) {
      requireOrganizer(actor, body.organizerPlayerId);
      const at = now();
      const row = db
        .insert(tournamentTemplate)
        .values({ leagueId, ...(templateColumns(body) as Required<ReturnType<typeof templateColumns>>), createdAt: at, updatedAt: at })
        .returning()
        .get();
      return templateView(row);
    },

    updateTemplate(leagueId, id, patch, actor) {
      const current = templateView(templateRow(leagueId, id));
      assertMayActAs(deps.connections, actor, current.organizerPlayerId, { local: true, ownerCleanup: true });
      if (patch.organizerPlayerId !== undefined) requireOrganizer(actor, patch.organizerPlayerId);
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

    archiveTemplate(leagueId, id, actor) {
      const row = templateRow(leagueId, id);
      assertMayActAs(deps.connections, actor, row.organizerPlayerId, { local: true, ownerCleanup: true });
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
      const overrides = body.overrides ?? {};
      const contactEmail = overrides.contactEmail !== undefined ? overrides.contactEmail : template.contactEmail;
      const contactPhone = overrides.contactPhone !== undefined ? overrides.contactPhone : template.contactPhone;
      if (contactEmail === null && contactPhone === null) throw new TournamentsError('contact_required', 'Give this tournament a contact email or phone.');
      const startTime = body.startTime ?? template.startTime;
      const row = db.transaction(() => {
        const clash = rowAt(leagueId, template.id, body.localDate, startTime);
        if (clash) {
          throw new TournamentsError('already_planned', `“${template.name}” is already planned on ${body.localDate} at ${startTime}.`, {
            plannedTournamentId: clash.id,
          });
        }
        return db
          .insert(plannedTournament)
          .values({ leagueId, templateId: template.id, localDate: body.localDate, startTime, overrides, seriesOverride: body.seriesId ?? null, createdAt: now() })
          .returning()
          .get();
      });
      return entryOf(row, contextFor([row]));
    },

    updatePlanned(leagueId, id, patch, actor) {
      const row = plannedRow(leagueId, id);
      const { organizerPlayerId } = templateRow(leagueId, row.templateId);
      assertMayActAs(deps.connections, actor, organizerPlayerId, { local: true, ownerCleanup: true });
      if (row.state === 'unknown' || heldSkipped(row)) return updateUnsettled(row, patch);
      if (!REPLANNABLE.has(row.state)) {
        throw new TournamentsError('not_editable', 'This tournament has reached play-tools, or is being created. Change it there, or with Edit….', { state: row.state });
      }
      const warnings: 'another_planned_at_time'[] = [];
      const overrides = { ...(readOverrides(row.overrides) as RowOverrides) };
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
      return read(leagueId, from, to, range.refresh ? 'refresh' : 'cached');
    },

    async createThrough(leagueId, scheduleId, through) {
      const schedule = scheduleRow(leagueId, scheduleId);
      if (!scheduleActive(schedule)) {
        throw new TournamentsError('schedule_inactive', 'This schedule is paused or archived. Resume it to create its tournaments.');
      }
      const window = creatableWindow(now(), deps.timeZone);
      if (through < window.from) throw new TournamentsError('date_too_far_past', `Choose a date from ${window.from} on.`);
      if (through > window.to) throw new TournamentsError('date_too_far_ahead', `${through} is more than 12 months ahead.`);
      db.transaction(() => syncSchedule(leagueId, schedule, through));
      materialise(leagueId);
      // What a job will create is decided from a live listing, never the cache (#98).
      const listed = await read(leagueId, window.from, through, 'live');
      const rows = listed.tournaments
        .filter((e) => e.scheduleId === scheduleId && e.plannedId !== null)
        .map((entry) => ({ id: entry.plannedId!, localDate: entry.localDate, state: entry.state as PlannedRowState, startsAt: entry.startsAt ?? entry.startTime, entry }));
      const picked = selectCreateThrough(rows, { windowStart: window.from, through });
      return {
        scheduleId,
        scaffoldName: scheduleView(schedule).scaffoldName,
        from: window.from,
        through,
        tournaments: picked.tournaments.map((r) => ({ ...r.entry, shortNotice: isShortNotice(r.localDate, today()) })),
        leftOut: picked.leftOut.map((l) => ({ entry: l.row.entry, reason: l.reason })),
        count: picked.count,
        tooMany: picked.tooMany,
        suggestedThrough: picked.suggestedThrough,
        unread: listed.unread,
      };
    },

    creation,

    async options(leagueId, query) {
      const c = deps.connections.listActingConnections().find((x) => x.professorPlayerId === query.professor);
      if (!c) throw new TournamentsError('connection_not_found', `Professor ${query.professor} isn't connected.`);
      if (c.status === 'needs_reconnect') {
        throw new TournamentsError('needs_reconnect', `Reconnect ${c.professorName ?? `Professor ${query.professor}`} in Settings to read play-tools' choices.`, {
          professorPlayerId: query.professor,
        });
      }
      const group = deps.connections.league(leagueId)?.id;
      if (!group) throw new TournamentsError('league_not_selected', 'Choose the league in Settings first.');
      const list = await live.series(c.id, group);
      const formats = await live.formats(c.id, query.country);
      const venues = await live.venues(c.id, group, query.country);
      const offered = query.date
        ? offeredOn(list, { country: query.country, date: query.date })
        : offeredOn(list, { country: query.country, range: { from: today(), to: addMonths(today(), 12) } });
      return {
        types: [
          { kind: 'custom' },
          ...offered.map((s) => ({
            kind: 'premier' as const,
            seriesId: s.id,
            name: s.name,
            product: s.product,
            categories: [...s.categories],
            window: s.windows[query.country]!,
          })),
        ],
        formats: formats.map((f) => ({ product: f.product, categories: [...f.categories] })),
        venues: venues.map((v) => ({ id: v.id, label: v.name ?? v.formattedAddress ?? v.id, country: v.country, timeZone: v.timeZone })),
      };
    },

    async calendarEvents(leagueId, range, mode) {
      if (mode === 'local') {
        const rows = plannedIn(leagueId, range.from, range.to);
        const ctx = contextFor(rows);
        return { tournaments: sortCalendar(rows.map((r) => calendarOfRow(r, ctx, undefined))), upstream: 'local', read: [], failed: [], unmatched: false };
      }
      materialise(leagueId);
      let rows = plannedIn(leagueId, range.from, range.to);
      const conns = deps.connections.listReadableConnections();
      const group = conns.length === 0 ? null : (deps.connections.league(leagueId)?.id ?? null);
      const status = conns.length === 0 ? 'not_connected' : group === null ? 'league_not_selected' : 'read';
      if (group === null) {
        const ctx = contextFor(rows);
        return { tournaments: sortCalendar(rows.map((r) => calendarOfRow(r, ctx, undefined))), upstream: status, read: [], failed: [], unmatched: false };
      }
      const listed = await listLeagueTournaments(conns, group, range.from, range.to, 'refresh');
      if (await linkUnknown(leagueId, group, rows, listed.tournaments)) rows = plannedIn(leagueId, range.from, range.to);
      const ctx = contextFor(rows);
      const byId = new Map(listed.tournaments.map((l) => [l.tournament.id, l]));
      const linked = linkedGuids(leagueId);
      const planned = rows.map((r) => calendarOfRow(r, ctx, r.tournamentId === null ? undefined : byId.get(r.tournamentId)));
      const others = listed.tournaments
        .filter((l) => !linked.has(l.tournament.id))
        .filter((l) => {
          const localDate = dateIn(l.tournament.startsAt!, deps.timeZone);
          return localDate >= range.from && localDate <= range.to;
        })
        .map(calendarOfListed);
      const failedIds = new Set(listed.unread.map((u) => u.professor.playerId));
      const read = [
        ...new Set(conns.flatMap((c) => (c.professorPlayerId !== null && c.status === 'connected' && !failedIds.has(c.professorPlayerId) ? [c.professorPlayerId] : []))),
      ];
      return {
        tournaments: sortCalendar([...planned, ...others]),
        upstream: status,
        read,
        failed: listed.unread.map((u) => ({ playerId: u.professor.playerId, code: u.code })),
        unmatched: conns.some((c) => c.professorPlayerId === null),
      };
    },

    async checkTournament(_leagueId, organizerPlayerId, tournamentId) {
      const c = deps.connections.listReadableConnections().find((x) => x.professorPlayerId === organizerPlayerId && x.status === 'connected');
      if (!c) return { kind: 'unreadable' };
      try {
        const t = await deps.gateway(c.id).getTournament(tournamentId);
        if (t.applicationState === 'cancelled' || GONE_STATUSES.has(t.status)) return { kind: 'cancelled' };
        return { kind: 'exists', startsAt: t.startsAt?.toISOString() ?? null };
      } catch (err) {
        if (!(err instanceof PokemonUpstreamError)) throw err;
        return err.code === 'not_found' ? { kind: 'cancelled' } : { kind: 'unreadable' };
      }
    },

    changed: (leagueId) => notifyChanged(leagueId),
  };
  return withChangeNotices(service);

  /** Planned rows whose local date is in the range, without planning anything. */
  function plannedIn(leagueId: string, from: LocalDate, to: LocalDate) {
    return db
      .select()
      .from(plannedTournament)
      .where(and(eq(plannedTournament.leagueId, leagueId), gte(plannedTournament.localDate, from), lte(plannedTournament.localDate, to)))
      .all();
  }

  function calendarOfRow(row: PlannedRow, ctx: EntryContext, listed: ListedTournament | undefined): CalendarTournament {
    const template = ctx.templates.get(row.templateId)!;
    const settings = settingsOf(row, ctx);
    let startsAt: string | null = null;
    let timeProblem: LocalTimeError['reason'] | undefined;
    try {
      startsAt = localInstant(row.localDate, row.startTime, settings.venue.timeZone).toISOString();
    } catch (err) {
      if (!(err instanceof LocalTimeError)) throw err;
      timeProblem = err.reason;
    }
    return {
      plannedId: row.id,
      tournamentId: row.tournamentId,
      state: row.state,
      organizerPlayerId: template.organizerPlayerId,
      name: settings.name,
      startsAt,
      ...(timeProblem && { timeProblem }),
      product: template.product,
      applicationState: listed?.tournament.applicationState ?? null,
      venueLabel: settings.venue.label,
      registration: settings.registration,
      eventWebsite: settings.eventWebsite,
      listedBy: listed?.organizer.professorPlayerId ?? null,
    };
  }

  function calendarOfListed({ tournament: t, organizer }: ListedTournament): CalendarTournament {
    return {
      plannedId: null,
      tournamentId: t.id,
      state: 'upstream',
      organizerPlayerId: organizer.professorPlayerId,
      name: t.name,
      startsAt: t.startsAt!.toISOString(),
      product: t.products.length === 1 ? t.products[0]! : null,
      applicationState: t.applicationState ?? null,
      venueLabel: null,
      registration: null,
      eventWebsite: null,
      listedBy: organizer.professorPlayerId,
    };
  }

  function sortCalendar(list: CalendarTournament[]): CalendarTournament[] {
    return list.sort(
      (a, b) =>
        (a.startsAt ?? '￿').localeCompare(b.startsAt ?? '￿') ||
        (a.plannedId ?? Number.MAX_SAFE_INTEGER) - (b.plannedId ?? Number.MAX_SAFE_INTEGER) ||
        (a.tournamentId ?? '').localeCompare(b.tournamentId ?? ''),
    );
  }

  /** Never throws into the write that changed something: the calendar logs its own failures. */
  function notifyChanged(leagueId: string): void {
    try {
      void Promise.resolve(deps.onTournamentsChanged?.(leagueId)).catch(() => undefined);
    } catch {
      // A synchronous throw from the callback is the calendar's to log, never the write's.
    }
  }

  /** Each write in `CHANGING_METHODS` tells the calendar once it has committed (ADR-0016 §5). */
  function withChangeNotices(s: TournamentsService): TournamentsService {
    for (const name of CHANGING_METHODS) {
      const write = s[name] as (leagueId: string, ...rest: unknown[]) => unknown;
      const wrapped = (leagueId: string, ...rest: unknown[]) => {
        const result = write(leagueId, ...rest);
        if (result instanceof Promise) return result.then((v: unknown) => (notifyChanged(leagueId), v));
        notifyChanged(leagueId);
        return result;
      };
      Object.assign(s, { [name]: wrapped });
    }
    return s;
  }
}
