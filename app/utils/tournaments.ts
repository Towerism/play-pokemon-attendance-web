import type { CoverageStatus, PeriodCoverage, UnreadProfessor, Urgency } from '../../shared/requirements/coverage';
import type { RequiredEventsCoverage } from '../../server/modules/tournaments/required-events';
import type { Requirement } from '../../server/modules/tournaments/requirements';
import type { SupportDetails, TournamentItemOutcome } from '../../server/modules/submission/service';
import type { LeftOutReason } from '../../server/modules/tournaments/create';
import type { CarriedField, EditValues } from '../../server/modules/tournaments/edit';
import type { CreateThroughPreview, Template, TournamentOptions, Upcoming, UpcomingEntry } from '../../server/modules/tournaments/service';
import type { RegistrationSettings } from '../../server/modules/tournaments/settings';
import type { PlannedOverrides } from '../../shared/schemas/tournaments';
import { addDays, dayLabel, periodLabel } from './dates';
import { unreadWarning } from './staff';

// The Tournaments page's decisions (#98, ADR-0010 decisions 6, 10–12): what each required-events cell, Upcoming
// entry and dialog shows, and what it may send. Pure, so it's unit-tested; the components only bind it. Every
// "today" is the league's date, passed in.

export type LocalDate = string;
export type BadgeColor = 'neutral' | 'info' | 'success' | 'warning' | 'error';

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

/** The game's usual name: play-tools' product codes aren't what organizers call them. */
export const GAME: Record<'tcg' | 'pgo' | 'vg', string> = { tcg: 'TCG', pgo: 'GO', vg: 'VGC' };

/** "League Cup · TCG · each quarter". */
export function requirementLabel(r: Pick<Requirement, 'seriesMatch' | 'product' | 'cadence'>): string {
  return `${r.seriesMatch} · ${GAME[r.product]} · each ${r.cadence}`;
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
export function entryStatus(
  e: Pick<UpcomingEntry, 'state' | 'tournamentId' | 'upstreamStatus' | 'errorCode'> & Partial<Pick<UpcomingEntry, 'skippedWhileUnknown'>>,
): { label: string; color: BadgeColor } {
  switch (e.state) {
    case 'planned':
      return { label: 'Planned', color: 'neutral' };
    case 'skipped':
      if (e.tournamentId) return { label: 'In play-tools, skipped here', color: 'warning' };
      return e.skippedWhileUnknown ? { label: 'Skipped, may be in play-tools', color: 'warning' } : { label: 'Skipped', color: 'neutral' };
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
 * **Cancel…** and **Download TDF**. While its organizer can't act, only the local ones, with why; while another user holds
 * the organizer's connection (`only`), only **Download TDF**.
 */
export function rowActions(e: UpcomingEntry, only: string | null = null): { actions: RowAction[]; organizerNote: string | null; settings: boolean } {
  const actions: RowAction[] = [...e.actions];
  const upstreamCancelled = e.upstreamStatus === 'cancelled';
  // A row skipped while its create may have landed is edited only once unskipped (#125).
  if (!['creating', 'unknown', 'cancelled'].includes(e.state) && !e.skippedWhileUnknown && !upstreamCancelled) actions.push('edit');
  if (e.tournamentId && !['cancelled', 'creating', 'unknown'].includes(e.state) && !upstreamCancelled && e.upstreamStatus !== 'complete') actions.push('cancel');
  if (e.tdfAvailable) actions.push('download');

  // Another user holds the organizer's connection (ADR-0015 §4): only the file, which reads nothing upstream, is theirs too.
  if (only) return { actions: actions.filter((a) => a === 'download'), organizerNote: only, settings: false };
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
export function retryContext(
  e: UpcomingEntry,
  all: readonly UpcomingEntry[],
  unread: Upcoming['unread'],
): { sentAt: string | null; sameDay: UpcomingEntry[]; blocked: string | null } {
  const sameDay = all.filter(
    (x) => x !== e && x.localDate === e.localDate && (x.state === 'created' || x.state === 'upstream') && x.organizer?.playerId === e.organizer?.playerId,
  );
  const unreadOrganizer = unread.find((u) => u.professor.playerId === e.organizer?.playerId);
  // Without the organizer's listing, "None listed" would hide a create that landed.
  const blocked =
    e.state !== 'unknown'
      ? 'It landed in play-tools: nothing to retry.'
      : unreadOrganizer
        ? `Couldn’t read ${professorName(unreadOrganizer.professor)}’s tournaments from play-tools, so a retry could make a duplicate. Try again later.`
        : null;
  return { sentAt: e.lastAttemptAt, sameDay, blocked };
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

export type TournamentsTab = 'upcoming' | 'required' | 'templates' | 'schedules';

/** `?tab=`; anything else is Upcoming. */
export function tabFromQuery(q: unknown): TournamentsTab {
  return q === 'required' || q === 'templates' || q === 'schedules' ? q : 'upcoming';
}

/** The route query with `tab` set; Upcoming, the default, is left out of the URL. */
export function tabQuery(query: Record<string, unknown>, tab: TournamentsTab): Record<string, unknown> {
  const { tab: _old, ...rest } = query;
  return tab === 'upcoming' ? rest : { ...rest, tab };
}

/**
 * The Tournaments tabs (#162; ADR-0010 decisions 10 and 12): Required events is its own tab, carrying the nav
 * badge's count (cells at risk or worse) when there is any, in its accessible name as well.
 */
export function tournamentsTabs(attention: number): { value: TournamentsTab; label: string; badge?: string; ariaLabel?: string }[] {
  const required =
    attention > 0
      ? { value: 'required' as const, label: 'Required events', badge: String(attention), ariaLabel: `Required events, ${attention} need${attention === 1 ? 's' : ''} attention` }
      : { value: 'required' as const, label: 'Required events' };
  return [{ value: 'upcoming', label: 'Upcoming' }, required, { value: 'templates', label: 'Templates' }, { value: 'schedules', label: 'Schedules' }];
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

/** One line of This week's required-events banner (ADR-0010 decision 12, #99). */
export interface BannerLine {
  text: string;
  tone: 'warning' | 'error';
  /** **Reconnect** (to Settings) or **Retry** (list play-tools again), for a professor whose read failed. */
  action: 'reconnect' | 'retry' | null;
}

/** Louder first (ADR-0010 decision 12's scale); a sanctioning error at any other urgency after them. */
const BANNER_RANK: Partial<Record<Urgency, number>> = { missed: 0, last_chance: 1, short_notice: 2, at_risk: 3 };
const PROBLEM_RANK = 4;

const UNREAD_REASON: Record<UnreadProfessor['code'], string> = {
  needs_reconnect: 'needs reconnect',
  upstream_unavailable: 'play-tools unavailable',
  refused: 'refused',
};

const capitalised = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Whose tournaments a `unknown` cell couldn't read, with why. */
function unreadWho(p: PeriodCoverage, unread: readonly UnreadProfessor[]): string {
  const professors = p.unreadProfessors.map((prof) => {
    const code = unread.find((u) => u.professor.playerId === prof.playerId)?.code;
    return `${professorName(prof)}’s tournaments${code ? ` (${UNREAD_REASON[code]})` : ''}`;
  });
  if (professors.length) return professors.join(' and ');
  return p.unreadTournaments.map((t) => `${t.displayId ?? 'a tournament'}’s details`).join(' and ') || 'some tournaments';
}

function cellLine(req: Requirement, p: PeriodCoverage, c: Pick<RequiredEventsCoverage, 'unread'>, today: LocalDate): string {
  const what = `a ${req.seriesMatch} for ${GAME[req.product]}`;
  const period = periodLabel(p, req.cadence);
  const latest = dayLabel(p.latestDate);
  if (p.status === 'unknown') return `Can’t confirm ${what} in ${period}: ${unreadWho(p, c.unread)} couldn’t be read. The last date is ${latest}.`;
  if (p.status === 'problem') {
    const errored = p.tournaments.find((t) => t.class === 'problem')?.displayId ?? 'A tournament';
    return `${errored} has a sanctioning error in play-tools: it doesn’t cover ${what} in ${period}.`;
  }
  const status = STATUS[p.status].label;
  switch (p.urgency) {
    case 'missed':
      return `Missed: no ${req.seriesMatch} for ${GAME[req.product]} in ${period}. The last date was ${latest}.`;
    case 'last_chance':
      return `Last chance for ${what} in ${period}: a tournament held ${dayLabel(firstCreatable(p, today) ?? p.latestDate)} to ${latest} can still be sanctioned.`;
    case 'short_notice':
      return `${capitalised(what)} in ${period} is short notice (${status}): the sanction-by date, ${dayLabel(p.sanctionBy)}, has passed. A tournament up to ${latest} can still be sanctioned.`;
    default:
      return `${capitalised(what)} in ${period} is at risk (${status}). Sanction by ${dayLabel(p.sanctionBy)}; the last date is ${latest}.`;
  }
}

/**
 * This week's required-events banner (ADR-0010 decision 12): a line per cell at risk or louder, or with a sanctioning
 * error, most urgent first (then by latest date, then requirement order), then one per professor whose read failed.
 * It can't be dismissed: a line goes only when its cause does.
 */
export function bannerLines(c: Pick<RequiredEventsCoverage, 'requirements' | 'unread'>, today: LocalDate): BannerLine[] {
  const cells: { rank: number; latestDate: LocalDate; order: number; line: BannerLine }[] = [];
  c.requirements.forEach(({ requirement, periods }, order) => {
    for (const p of periods) {
      const loud = p.urgency !== null ? BANNER_RANK[p.urgency] : undefined;
      if (loud === undefined && p.status !== 'problem') continue;
      const rank = loud ?? PROBLEM_RANK;
      const tone = rank <= 1 || p.status === 'problem' ? 'error' : 'warning';
      cells.push({ rank, latestDate: p.latestDate, order, line: { text: cellLine(requirement, p, c, today), tone, action: null } });
    }
  });
  cells.sort((a, b) => a.rank - b.rank || a.latestDate.localeCompare(b.latestDate) || a.order - b.order);
  const professors: BannerLine[] = c.unread.map((u) => ({
    text: `Couldn’t read ${professorName(u.professor)}’s tournaments: ${u.message}`,
    tone: 'warning',
    action: u.code === 'needs_reconnect' ? 'reconnect' : 'retry',
  }));
  return [...cells.map((x) => x.line), ...professors];
}

/** Upcoming's query: one date range (This week's cards, #99), and/or a fresh listing instead of the 5-minute cache. */
export function upcomingQuery(opts: { upstream?: boolean; range?: { from: LocalDate; to: LocalDate } }): Record<string, string> {
  return { ...(opts.range ?? {}), ...(opts.upstream ? { refresh: '1' } : {}) };
}

// New tournament with details changed from its template (#162): the dialog pre-fills the template's details, and
// sends only the ones that differ, so a later template edit still reaches the rest (ADR-0010 decision 4).

/** The type left as the template's: no series pick is sent. Can't be a series id (those are `[A-Za-z0-9-]`). */
export const AS_TEMPLATE = '@template';

/** The New tournament dialog's details, as its fields hold them: text fields are strings, blank for none. */
export interface NewTournamentDetails {
  name: string;
  /** {@link AS_TEMPLATE}, `custom`, or a play-tools series id. */
  typeKey: string;
  category: string;
  venue: Template['venue'];
  registration: RegistrationSettings;
  contactEmail: string;
  contactPhone: string;
  details: string;
  eventWebsite: string;
}

export function detailsFromTemplate(t: Template): NewTournamentDetails {
  return {
    name: t.name,
    typeKey: AS_TEMPLATE,
    category: t.category,
    venue: { ...t.venue },
    // A flat object; spread rather than structuredClone, which can't copy the reactive proxy a component passes.
    registration: { ...t.registration },
    contactEmail: t.contactEmail ?? '',
    contactPhone: t.contactPhone ?? '',
    details: t.details ?? '',
    eventWebsite: t.eventWebsite ?? '',
  };
}

/** A registration by what it means: a blank admission is none, and the field order doesn't matter. */
function registrationKey(r: RegistrationSettings): string {
  return r.kind === 'on_site'
    ? JSON.stringify([r.kind, r.opensBeforeMin, r.closesAfterMin, blankToNull(r.admission)])
    : JSON.stringify([r.kind, r.url.trim()]);
}

const NEW_TOURNAMENT_TEXT = ['contactEmail', 'contactPhone', 'details', 'eventWebsite'] as const;

/**
 * What **Plan tournament** sends beyond the template, the date and the time: only the details whose meaning differs
 * from the template's (a venue by its id, a registration by its fields, a blank text as none), and the type unless
 * it is left as the template's. `count` is what "N details differ from the template" says.
 */
export function newTournamentChanges(base: NewTournamentDetails, form: NewTournamentDetails): { overrides: PlannedOverrides; seriesId?: string; count: number } {
  const overrides: PlannedOverrides = {};
  if (form.name.trim() !== base.name.trim()) overrides.name = form.name.trim();
  if (form.category !== base.category) overrides.category = form.category;
  if (form.venue.id !== base.venue.id) overrides.venue = form.venue;
  if (registrationKey(form.registration) !== registrationKey(base.registration)) overrides.registration = form.registration;
  for (const field of NEW_TOURNAMENT_TEXT) {
    if (blankToNull(form[field]) !== blankToNull(base[field])) overrides[field] = blankToNull(form[field]);
  }
  const seriesId = form.typeKey === AS_TEMPLATE ? undefined : form.typeKey;
  return { overrides, ...(seriesId && { seriesId }), count: Object.keys(overrides).length + (seriesId ? 1 : 0) };
}

type OptionSeries = Extract<TournamentOptions['types'][number], { kind: 'premier' }>;

/** The game's series play-tools offers on the date (its window holds it). */
function seriesOn(t: Template, o: TournamentOptions, date: LocalDate): OptionSeries[] {
  return o.types.filter((x): x is OptionSeries => x.kind === 'premier' && x.product === t.product && x.window.from <= date && date <= x.window.to);
}

/**
 * The type dropdown for the date (ADR-0010 decision 6): the template's own type first, then Custom (only for a
 * premier template: a custom one's own type already is Custom), then the game's series offered that day.
 */
export function newTournamentTypeChoices(t: Template, o: TournamentOptions | null, date: LocalDate): { value: string; label: string }[] {
  const own =
    t.type.kind === 'premier' ? { value: AS_TEMPLATE, label: `${t.type.seriesMatch} (resolved for the date)` } : { value: AS_TEMPLATE, label: 'Custom' };
  if (!o) return [own];
  return [own, ...(t.type.kind === 'premier' ? [{ value: 'custom', label: 'Custom' }] : []), ...seriesOn(t, o, date).map((s) => ({ value: s.seriesId, label: s.name }))];
}

/** Whether a picked type still holds on the date: a series only while its window does. */
export function typeStillOffered(typeKey: string, o: TournamentOptions | null, date: LocalDate): boolean {
  if (typeKey === AS_TEMPLATE || typeKey === 'custom') return true;
  const s = o?.types.find((x): x is OptionSeries => x.kind === 'premier' && x.seriesId === typeKey);
  return !!s && s.window.from <= date && date <= s.window.to;
}

/**
 * The format dropdown, following the type (ADR-0010 decision 6): a picked series' formats; the game's for Custom;
 * for a premier template left as it is, those of the one series it resolves to that day (as `resolveSeries` finds
 * it), else the game's with a note. Only the template's format when play-tools' choices couldn't be read.
 */
export function newTournamentFormats(t: Template, typeKey: string, o: TournamentOptions | null, date: LocalDate): { formats: string[]; note: string | null } {
  if (!o) return { formats: [t.category], note: null };
  const game = o.formats.find((f) => f.product === t.product)?.categories ?? [];
  if (typeKey === 'custom' || (typeKey === AS_TEMPLATE && t.type.kind === 'custom')) return { formats: [...game], note: null };
  if (typeKey !== AS_TEMPLATE) {
    const picked = o.types.find((x): x is OptionSeries => x.kind === 'premier' && x.seriesId === typeKey);
    return { formats: [...(picked?.categories ?? game)], note: null };
  }
  const match = (t.type as { seriesMatch: string }).seriesMatch.toLowerCase();
  const found = seriesOn(t, o, date).filter((s) => s.name.toLowerCase().includes(match));
  if (found.length === 1) return { formats: [...found[0]!.categories], note: null };
  return { formats: [...game], note: `No single ${(t.type as { seriesMatch: string }).seriesMatch} series for ${dayLabel(date)}; check the format when you create it.` };
}

const PLANNED_ERROR: Record<string, (template: string) => string> = {
  already_planned: () => 'That tournament is already planned for this date and time. Change it with Edit… instead.',
  template_archived: (template) => `“${template}” is archived. Choose another template.`,
  contact_required: () => 'Give this tournament a contact email or phone.',
};

/** What the New tournament dialog says for a refusal it knows; null for play-tools' or the server's own message. */
export function plannedErrorText(code: string | undefined, templateName = 'That template'): string | null {
  return (code && PLANNED_ERROR[code]?.(templateName)) ?? null;
}
