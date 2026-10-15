import type { CoverageStatus, PeriodCoverage, UnreadProfessor, Urgency } from '../../shared/requirements/coverage';
import type { Cadence } from '../../shared/requirements/periods';
import type { RequiredEventsCoverage } from '../../server/modules/tournaments/required-events';
import type { Requirement } from '../../server/modules/tournaments/requirements';
import type { SupportDetails, TournamentItemOutcome } from '../../server/modules/submission/service';
import type { LeftOutReason } from '../../server/modules/tournaments/create';
import type { CarriedField, EditValues } from '../../server/modules/tournaments/edit';
import type { CreateThroughPreview, Template, TournamentOptions, Upcoming, UpcomingEntry } from '../../server/modules/tournaments/service';
import { unreadWarning } from './staff';

// The Tournaments page's decisions (#98, ADR-0010 decisions 6, 10–12): what each required-events cell, Upcoming
// entry and dialog shows, and what it may send. Pure, so it's unit-tested; the components only bind it. Every
// "today" is the league's date, passed in.

export type LocalDate = string;
export type BadgeColor = 'neutral' | 'info' | 'success' | 'warning' | 'error';

const DAY = 86_400_000;

/** `date` + `days`, as YYYY-MM-DD. */
export function addDays(date: LocalDate, days: number): LocalDate {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

/** Today in the league's time zone: short notice and sanction-by count from it, never the browser's date. */
export function todayIn(timeZone: string, now: Date): LocalDate {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Today through 6 days ahead: less than 7 days before it is held (ADR-0010 decision 6). */
export function isShortNotice(date: LocalDate, today: LocalDate): boolean {
  return date >= today && date <= addDays(today, 6);
}

/** Urgencies the nav badge counts: at risk or worse (ADR-0010 decision 12). */
const LOUD: ReadonlySet<Urgency> = new Set(['at_risk', 'short_notice', 'last_chance', 'missed']);

/** How many required-events cells need attention, for the Tournaments link's badge. */
export function badgeCount(coverage: Pick<RequiredEventsCoverage, 'requirements'> | null | undefined): number {
  if (!coverage) return 0;
  return coverage.requirements.reduce((n, r) => n + r.periods.filter((p) => p.urgency !== null && LOUD.has(p.urgency)).length, 0);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 2026", or "Q4 2026" for a calendar quarter. */
export function periodLabel(p: Pick<PeriodCoverage, 'periodStart'>, cadence: Cadence): string {
  const [year, month] = p.periodStart.split('-').map(Number) as [number, number];
  return cadence === 'quarter' ? `Q${Math.floor((month - 1) / 3) + 1} ${year}` : `${MONTHS[month - 1]} ${year}`;
}

/** The game's usual name: play-tools' product codes aren't what organizers call them. */
export const GAME: Record<'tcg' | 'pgo' | 'vg', string> = { tcg: 'TCG', pgo: 'GO', vg: 'VGC' };

/** "League Cup · TCG · each quarter". */
export function requirementLabel(r: Pick<Requirement, 'seriesMatch' | 'product' | 'cadence'>): string {
  return `${r.seriesMatch} · ${GAME[r.product]} · each ${r.cadence}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Thu 31 Dec": a league date, read as a calendar date (no time zone shift). */
export function dayLabel(date: LocalDate): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

const STATUS: Record<CoverageStatus, { label: string; color: BadgeColor }> = {
  sanctioned: { label: 'Sanctioned', color: 'success' },
  covered_manual: { label: 'Covered (manual)', color: 'success' },
  pending: { label: 'Approval pending', color: 'info' },
  planned: { label: 'Planned, not in play-tools', color: 'warning' },
  problem: { label: 'Sanctioning error', color: 'error' },
  missing: { label: 'Missing', color: 'error' },
  unknown: { label: 'Can’t confirm', color: 'warning' },
};

const URGENCY: Record<Urgency, { label: string; color: BadgeColor }> = {
  open: { label: 'Open', color: 'neutral' },
  at_risk: { label: 'At risk', color: 'warning' },
  short_notice: { label: 'Short notice', color: 'warning' },
  last_chance: { label: 'Last chance', color: 'error' },
  missed: { label: 'Missed', color: 'error' },
};

export type CellAction = 'plan' | 'create' | 'open' | 'cover' | 'uncover';

export interface CellView {
  status: { label: string; color: BadgeColor };
  urgency: { label: string; color: BadgeColor } | null;
  lines: string[];
  actions: CellAction[];
  /** The planned tournament **Create in play-tools** starts. */
  createPlannedId: number | null;
  /** What to look for in play-tools, for a sanctioning error. */
  openText: string | null;
}

/** How long after a date a tournament can still be created, so sanctioned after the fact (ADR-0010 decision 6). */
const BACK_DATING_DAYS = 2;

/** The earliest date in the period a tournament can still be created on; null when none is left. */
function firstCreatable(p: Pick<PeriodCoverage, 'periodStart' | 'latestDate'>, today: LocalDate): LocalDate | null {
  const earliest = addDays(today, -BACK_DATING_DAYS);
  const date = p.periodStart > earliest ? p.periodStart : earliest;
  return date <= p.latestDate ? date : null;
}

/** A professor by display name, else "Professor <player id>". */
export function professorName(o: { playerId: string | null; name: string | null } | null): string {
  return o?.name ?? (o?.playerId ? `Professor ${o.playerId}` : 'an unknown professor');
}

/** One required-events cell (ADR-0010 decision 12): what it says and what fixes it. */
export function cellView(req: Requirement, p: PeriodCoverage, ctx: { today: LocalDate; unread: readonly UnreadProfessor[] }): CellView {
  const lines = [`Latest date ${dayLabel(p.latestDate)}`];
  if (p.urgency === 'open' || p.urgency === 'at_risk') lines.push(`Sanction by ${dayLabel(p.sanctionBy)}`);
  for (const t of p.tournaments) lines.push(`${t.displayId ?? 'not in play-tools'} · ${dayLabel(t.localDate)} · ${professorName(t.organizer)}`);
  if (p.manualCover) lines.push(`Covered by hand: “${p.manualCover.note}” (${p.manualCover.createdBy}, ${p.manualCover.createdAt.slice(0, 10)})`);
  if (p.noSeries) lines.push(`play-tools offers no series matching “${req.seriesMatch}” for ${GAME[req.product]} this ${req.cadence}`);
  if (p.status === 'unknown') {
    for (const prof of p.unreadProfessors) {
      const message = ctx.unread.find((u) => u.professor.playerId === prof.playerId)?.message;
      lines.push(`Couldn’t read ${professorName(prof)}’s tournaments${message ? `: ${message}` : ''}`);
    }
    if (p.bestKnown) lines.push(`Best known: ${STATUS[p.bestKnown].label}`);
  }

  const actions: CellAction[] = [];
  const action = p.action;
  if (action?.kind === 'plan' && firstCreatable(p, ctx.today) !== null) actions.push('plan');
  if (action?.kind === 'create') actions.push('create');
  if (action?.kind === 'open_in_play_tools') actions.push('open');
  if (p.status === 'covered_manual') actions.push('uncover');
  else if (p.status !== 'sanctioned') actions.push('cover');

  const problem = action?.kind === 'open_in_play_tools' ? p.tournaments.find((t) => t.tournamentId === action.tournamentId) : undefined;
  return {
    status: STATUS[p.status],
    urgency: p.urgency ? URGENCY[p.urgency] : null,
    lines,
    actions,
    createPlannedId: action?.kind === 'create' ? action.plannedId : null,
    openText: action?.kind === 'open_in_play_tools' ? `Look for ${problem?.displayId ?? 'the tournament with a sanctioning error'}` : null,
  };
}

/** An Upcoming entry's status (ADR-0010 decision 10): the row's state, or play-tools' status once it is there. */
export function entryStatus(e: Pick<UpcomingEntry, 'state' | 'tournamentId' | 'upstreamStatus' | 'errorCode'>): { label: string; color: BadgeColor } {
  switch (e.state) {
    case 'planned':
      return { label: 'Planned', color: 'neutral' };
    case 'skipped':
      return e.tournamentId ? { label: 'In play-tools, skipped here', color: 'warning' } : { label: 'Skipped', color: 'neutral' };
    case 'creating':
      return { label: 'Creating…', color: 'info' };
    case 'failed':
      return { label: e.errorCode ? `Create failed (${e.errorCode})` : 'Create failed', color: 'error' };
    case 'cancelled':
      return { label: 'Cancelled', color: 'neutral' };
    case 'unknown':
      return { label: 'May have been created', color: 'warning' };
    default:
      if (e.upstreamStatus === 'approval-pending') return { label: 'Approval pending', color: 'info' };
      if (e.upstreamStatus === 'sanctioning-error') return { label: 'Sanctioning error', color: 'error' };
      if (e.upstreamStatus === 'cancelled') return { label: 'Cancelled', color: 'neutral' };
      if (e.upstreamStatus === 'complete') return { label: 'Complete', color: 'success' };
      return { label: 'In play-tools', color: 'success' };
  }
}

export type RowAction = 'create' | 'skip' | 'unskip' | 'retry_create' | 'edit' | 'cancel' | 'download';

/** Actions that change only this app's rows, offered whoever organizes the tournament. */
const LOCAL_ACTIONS: ReadonlySet<RowAction> = new Set(['skip', 'unskip', 'download']);

/**
 * Which buttons an Upcoming entry gets: the server's (`create`, `skip`, `unskip`, `retry_create`), then **Edit…**,
 * **Cancel…** and **Download TDF**. While its organizer can't act, only the local ones, with why.
 */
export function rowActions(e: UpcomingEntry): { actions: RowAction[]; organizerNote: string | null; settings: boolean } {
  const actions: RowAction[] = [...e.actions];
  const upstreamCancelled = e.upstreamStatus === 'cancelled';
  if (!['creating', 'unknown', 'cancelled'].includes(e.state) && !upstreamCancelled) actions.push('edit');
  if (e.tournamentId && !['cancelled', 'creating', 'unknown'].includes(e.state) && !upstreamCancelled && e.upstreamStatus !== 'complete') actions.push('cancel');
  if (e.tdfAvailable) actions.push('download');

  const o = e.organizer;
  if (o && o.connected && !o.needsReconnect) return { actions, organizerNote: null, settings: false };
  const note = o?.needsReconnect
    ? `Reconnect ${professorName(o)} in Settings to change this tournament.`
    : `Connect ${o ? `${professorName(o)}’s` : 'the organizer’s'} Pokémon account in Settings to change this tournament.`;
  return { actions: actions.filter((a) => LOCAL_ACTIONS.has(a)), organizerNote: note, settings: true };
}

/** States of a tournament not in play-tools yet, which still needs creating. */
const TO_CREATE: ReadonlySet<UpcomingEntry['state']> = new Set(['planned', 'failed', 'unknown']);

/** "Create by Fri 23 Oct", "Short notice" past the sanction-by date, "Back-dated" once held; null once in play-tools. */
export function sanctionTag(e: Pick<UpcomingEntry, 'state' | 'localDate' | 'sanctionBy'>, today: LocalDate): string | null {
  if (!TO_CREATE.has(e.state)) return null;
  if (e.localDate < today) return 'Back-dated';
  if (e.sanctionBy < today) return 'Short notice';
  return `Create by ${dayLabel(e.sanctionBy)}`;
}

/** Upcoming by league date, in the server's order. */
export function groupByDate(entries: readonly UpcomingEntry[]): { date: LocalDate; heading: string; entries: UpcomingEntry[] }[] {
  const groups: { date: LocalDate; heading: string; entries: UpcomingEntry[] }[] = [];
  for (const e of entries) {
    const last = groups.at(-1);
    if (last?.date === e.localDate) last.entries.push(e);
    else groups.push({ date: e.localDate, heading: dayLabel(e.localDate), entries: [e] });
  }
  return groups;
}

/**
 * The Retry create dialog's facts (ADR-0010 decision 5): when the earlier create was sent, and the organizer's
 * tournaments in play-tools that day, from a fresh read, so the organizer can see whether it landed.
 */
export function retryContext(e: UpcomingEntry, all: readonly UpcomingEntry[]): { sentAt: string | null; sameDay: UpcomingEntry[] } {
  const sameDay = all.filter(
    (x) => x !== e && x.localDate === e.localDate && (x.state === 'created' || x.state === 'upstream') && x.organizer?.playerId === e.organizer?.playerId,
  );
  return { sentAt: e.lastAttemptAt, sameDay };
}

/** Why Upcoming shows no play-tools tournaments, and one warning per professor who couldn't be read. */
export function upcomingNotice(u: Pick<Upcoming, 'upstream' | 'unread'>): { settingsNote: string | null; warnings: ReturnType<typeof unreadWarning>[] } {
  const settingsNote =
    u.upstream === 'not_connected'
      ? 'Connect a Pokémon account in Settings to see play-tools’ tournaments.'
      : u.upstream === 'league_not_selected'
        ? 'Choose a league in Settings to see play-tools’ tournaments.'
        : null;
  return { settingsNote, warnings: u.unread.map((x) => unreadWarning(x)) };
}

const OUTCOME: Record<TournamentItemOutcome, string> = {
  pending: 'Waiting',
  created: 'Created',
  already_exists: 'Already in play-tools (linked)',
  refused: 'Refused by play-tools',
  failed: 'Failed',
  skipped: 'Not sent',
  unknown: 'May have been created',
  date_too_far_past: 'Too far in the past',
  date_too_far_ahead: 'Too far ahead',
  edited: 'Edited',
  already_applied: 'Already up to date',
  cancelled: 'Cancelled',
  already_cancelled: 'Already cancelled',
  processing: 'Processing in play-tools',
  uploaded: 'Uploaded',
  not_accepted: 'Not accepted by play-tools',
  warnings_changed: 'Warnings changed; nothing sent',
  validate_unknown: 'May have been sent',
  processing_failed: 'play-tools couldn’t process it',
};

/** A tournament job item's outcome, in words. */
export function outcomeLabel(outcome: TournamentItemOutcome): string {
  return OUTCOME[outcome];
}

/**
 * The copyable block for Pokémon support (ADR-0010 decision 7): exactly these fields, one per line. It never holds a
 * token, a request body or player data, whatever else the object carries.
 */
export function supportText(s: SupportDetails): string {
  const lines = [
    `Action: ${s.action}`,
    `Sent: ${s.sentAt ?? '—'}`,
    `League: ${s.league.displayId ?? '—'}`,
    `Tournament: ${s.tournament.displayId ?? '(not created)'} · ${s.tournament.name} · ${s.tournament.date}`,
    `Professor: ${s.professor.name ?? 'Professor'} (${s.professor.playerId})`,
    `HTTP status: ${s.status ?? '—'}`,
    `play-tools code: ${s.code ?? '—'}`,
    `play-tools message: ${s.message ?? '—'}`,
    `Correlation id: ${s.correlationId ?? '—'}`,
  ];
  if (s.uploadGuid) lines.push(`Upload id: ${s.uploadGuid}`);
  if (s.errors?.length) lines.push(`Errors: ${s.errors.join(', ')}`);
  return lines.join('\n');
}

const LEFT_OUT: Record<LeftOutReason, string> = {
  skipped: 'Skipped',
  in_play_tools: 'Already in play-tools',
  creating: 'Being created',
  unknown: 'May have been created',
  before_window: 'Before the creatable window',
};

/** Why **Create through date…** leaves a date out. */
export function leftOutText(reason: LeftOutReason): string {
  return LEFT_OUT[reason];
}

/** At most this many tournaments in one create job (#92). */
export const MAX_CREATE = 60;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** The **Create through date…** confirm: its label, or why there's nothing to confirm. */
export function createThroughView(p: Pick<CreateThroughPreview, 'tournaments' | 'count' | 'tooMany' | 'suggestedThrough'>): {
  confirmLabel: string | null;
  disabledReason: string | null;
  suggestedThrough: LocalDate | null;
  shortNotice: number;
} {
  const shortNotice = p.tournaments.filter((t) => t.shortNotice).length;
  if (p.tooMany) return { confirmLabel: null, disabledReason: `${p.count} tournaments is more than ${MAX_CREATE} at a time.`, suggestedThrough: p.suggestedThrough, shortNotice };
  if (p.count === 0) return { confirmLabel: null, disabledReason: 'Nothing to create through this date.', suggestedThrough: null, shortNotice };
  return { confirmLabel: shortNotice ? 'Create anyway' : `Create ${plural(p.count, 'tournament')}`, disabledReason: null, suggestedThrough: null, shortNotice };
}

/** Cancel… asks for the display id when anyone is registered (#94); the server compares it exactly. */
export function cancelConfirmed(typed: string, confirmWith: string | null): boolean {
  return confirmWith === null || typed.trim() === confirmWith;
}

/** The saved file's name from `Content-Disposition` (`filename*` first), else "<display id>.tdf". */
export function downloadName(contentDisposition: string | null, displayId: string | null): string {
  const fallback = `${displayId ?? 'tournament'}.tdf`;
  if (!contentDisposition) return fallback;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(contentDisposition);
  if (star) {
    try {
      return decodeURIComponent(star[1]!.trim());
    } catch {
      return fallback;
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"/i.exec(contentDisposition) ?? /filename\s*=\s*([^;]+)/i.exec(contentDisposition);
  return plain?.[1]?.trim() || fallback;
}

/** Optional text: blank is empty (null), as the server's schemas read it; an email or URL that is there is checked. */
export function blankToNull(v: string | null): string | null {
  return v === null || v.trim() === '' ? null : v.trim();
}
const text = blankToNull;

const EDIT_FIELDS: readonly (keyof EditValues)[] = [
  'name',
  'category',
  'venue',
  'localDate',
  'startTime',
  'registration',
  'contactEmail',
  'contactPhone',
  'details',
  'eventWebsite',
];
const OPTIONAL_TEXT: ReadonlySet<keyof EditValues> = new Set(['contactEmail', 'contactPhone', 'details', 'eventWebsite']);

function sameField(field: keyof EditValues, a: EditValues, b: EditValues): boolean {
  if (field === 'venue') return a.venue.id === b.venue.id;
  if (field === 'registration') return JSON.stringify(a.registration) === JSON.stringify(b.registration);
  if (field === 'name') return a.name.trim() === b.name.trim();
  if (OPTIONAL_TEXT.has(field)) return text(a[field] as string | null) === text(b[field] as string | null);
  return a[field] === b[field];
}

/** The edit's `changes`: only the fields that differ from the fresh read, so nothing else is sent (#100). */
export function changedValues(before: EditValues, form: EditValues): Partial<EditValues> {
  const out: Partial<Record<keyof EditValues, unknown>> = {};
  for (const field of EDIT_FIELDS) {
    if (sameField(field, before, form)) continue;
    out[field] = OPTIONAL_TEXT.has(field) ? text(form[field] as string | null) : form[field];
  }
  return out as Partial<EditValues>;
}

const CARRIABLE: readonly CarriedField[] = ['name', 'category', 'venue', 'startTime', 'registration', 'contactEmail', 'contactPhone', 'details', 'eventWebsite'];

/**
 * Which changed fields carry over to the schedule's other tournaments by default (ADR-0010 decision 11): all of
 * them except the name, which often holds its month. The date never carries over, so it has no tick.
 */
export function defaultTicks(changed: readonly (keyof EditValues)[]): CarriedField[] {
  return CARRIABLE.filter((f) => f !== 'name' && changed.includes(f));
}

/** The edit form's field names, as the form and the preview show them. */
export const FIELD_LABEL: Record<keyof EditValues, string> = {
  name: 'Name',
  category: 'Format',
  venue: 'Venue',
  localDate: 'Date',
  startTime: 'Start time',
  registration: 'Registration',
  contactEmail: 'Contact email',
  contactPhone: 'Contact phone',
  details: 'Details',
  eventWebsite: 'Event website',
};

/** A field's value in words, for the preview's before → after. */
export function valueText(field: keyof EditValues, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'venue') return (value as EditValues['venue']).label ?? (value as EditValues['venue']).id ?? '—';
  if (field === 'registration') {
    const r = value as NonNullable<EditValues['registration']>;
    if (r.kind === 'third_party') return `Third party: ${r.url}`;
    return `On site: opens ${r.opensBeforeMin} min before, closes ${r.closesAfterMin} min after${r.admission ? `, admission ${r.admission}` : ''}`;
  }
  return String(value);
}

/** The preview entries the organizer unticked, as the apply's `excluded`. */
export function excludedKeys(entries: readonly { key: string }[], kept: ReadonlySet<string>): string[] {
  return entries.filter((e) => !kept.has(e.key)).map((e) => e.key);
}

export type TemplateTypeValue = { kind: 'custom' } | { kind: 'premier'; seriesMatch: string };

/** The template form's types, read live: Custom, then each premier series, which sets the match and the game. */
export function templateTypeChoices(o: TournamentOptions): { label: string; value: TemplateTypeValue; product?: string }[] {
  return o.types.map((t) =>
    t.kind === 'custom' ? { label: 'Custom', value: { kind: 'custom' } } : { label: t.name, value: { kind: 'premier', seriesMatch: t.name }, product: t.product },
  );
}

/** The form options' country when none is given: the server reads `US` venues by default (ADR-0010 Update #91). */
export const OPTIONS_COUNTRY = 'US';

export type OptionVenue = TournamentOptions['venues'][number];

/** A venue from the options as a template stores it; play-tools may leave out its time zone or country. */
export function venueValue(v: OptionVenue, leagueTimeZone: string): Template['venue'] {
  return { id: v.id, label: v.label, timeZone: v.timeZone ?? leagueTimeZone, country: v.country ?? OPTIONS_COUNTRY };
}

/** The venues to choose from: play-tools', with a saved one kept first when it's no longer listed. */
export function venueChoices(o: TournamentOptions | null, saved: Template['venue'] | null): OptionVenue[] {
  const listed = o?.venues ?? [];
  if (!saved || listed.some((v) => v.id === saved.id)) return [...listed];
  return [{ id: saved.id, label: saved.label, country: saved.country, timeZone: saved.timeZone }, ...listed];
}

export interface TemplateFormState {
  name: string;
  organizerPlayerId: string;
  category: string;
  venue: Template['venue'] | null;
  contactEmail: string;
  contactPhone: string;
  optionsLoaded: boolean;
  editing: boolean;
}

/** Why the template form can't be saved yet; null when it can. */
export function templateFormProblem(f: TemplateFormState): string | null {
  if (!f.name.trim()) return 'Name the template';
  if (!f.organizerPlayerId) return 'Choose the organizer';
  if (!f.optionsLoaded && !f.editing) return 'Waiting for play-tools’ choices';
  if (!f.category) return 'Choose a format';
  if (!f.venue) return 'Choose a venue';
  if (!text(f.contactEmail) && !text(f.contactPhone)) return 'Add a contact email or phone';
  return null;
}

type RequirementFields = Omit<Requirement, 'id'>;

/** A requirement row's `PATCH`: only what changed. */
export function requirementPatch(before: Requirement, form: RequirementFields): Partial<RequirementFields> {
  const out: Partial<Record<keyof RequirementFields, unknown>> = {};
  for (const k of ['seriesMatch', 'product', 'cadence', 'minCount', 'warnDays', 'active'] as const) if (before[k] !== form[k]) out[k] = form[k];
  return out as Partial<RequirementFields>;
}

export type TournamentsTab = 'upcoming' | 'templates' | 'schedules';

/** `?tab=`; anything else is Upcoming. */
export function tabFromQuery(q: unknown): TournamentsTab {
  return q === 'templates' || q === 'schedules' ? q : 'upcoming';
}

/**
 * **Plan one…** (ADR-0010 decision 12): the first premier template of the requirement's game whose series match
 * holds the requirement's, and the earliest date in the period that can still be created; null when none can.
 */
export function planOneDefaults(
  req: Requirement,
  p: Pick<PeriodCoverage, 'periodStart' | 'latestDate'>,
  templates: readonly Template[],
  today: LocalDate,
): { template: Template | null; date: LocalDate } | null {
  const date = firstCreatable(p, today);
  if (date === null) return null;
  const match = req.seriesMatch.toLowerCase();
  const template =
    [...templates]
      .sort((a, b) => a.id - b.id)
      .find((t) => !t.archived && t.product === req.product && t.type.kind === 'premier' && t.type.seriesMatch.toLowerCase().includes(match)) ?? null;
  return { template, date };
}
