import { dateIn } from '../time/local-time';
import { type Cadence, type LocalDate, addDays, periodsFor } from './periods';

/**
 * Required events coverage (ADR-0010 decision 12, #102, #95): which requirement is met in which calendar period,
 * how urgent the rest are, and what to do about them. Pure: the caller reads play-tools and the clock and passes
 * what it found, so every rule here is tested with fixed dates.
 */

export type Product = 'tcg' | 'pgo' | 'vg';

export interface RequirementInput {
  id: number;
  /** Matched against play-tools' series names, case-insensitively, as a substring. */
  seriesMatch: string;
  product: Product;
  cadence: Cadence;
  minCount: number;
  /** How many days before the latest date an uncovered period turns at risk. */
  warnDays: number;
}

export interface SeriesInput {
  id: string;
  name: string;
  product: string;
  /** Country → inclusive window. */
  windows: Readonly<Record<string, { from: LocalDate; to: LocalDate }>>;
}

export interface OrganizerRef {
  playerId: string;
  name: string | null;
}

export interface ManualCoverInput {
  requirementId: number;
  periodStart: LocalDate;
  note: string;
  createdBy: string;
  createdAt: string;
}

export interface UnreadProfessor {
  professor: { playerId: string | null; name: string | null };
  code: 'needs_reconnect' | 'upstream_unavailable' | 'refused';
  message: string;
}

export interface ListedInput {
  tournamentId: string;
  displayId: string | null;
  products: readonly string[];
  /** True UTC start, ISO. */
  startsAt: string;
  status: string;
  applicationState: string | null;
  /** From the tournament's details: its series (null for a custom event), or `unread` when they couldn't be read. */
  series: { id: string; name: string | null } | null | 'unread';
  organizer: OrganizerRef | null;
}

/** How a planned tournament's type came out, for coverage. */
export type PlannedSeries =
  /** Resolved for its date from its organizer's series list. */
  | { kind: 'resolved'; name: string }
  /** Its organizer's series couldn't be read; the template's own series match stands in. */
  | { kind: 'fallback'; match: string }
  /** Its organizer's series couldn't be read and it has a series pick: nothing to compare. */
  | { kind: 'unjudged' }
  /** Custom, or a premier match play-tools doesn't resolve to one series (the row needs a pick). */
  | { kind: 'none' };

export interface PlannedInput {
  plannedId: number;
  /** The league-`TZ` date of its start. */
  localDate: LocalDate;
  product: string;
  series: PlannedSeries;
  organizer: OrganizerRef | null;
}

export interface CoverageInput {
  /** In the league `TZ`. */
  today: LocalDate;
  timeZone: string;
  /** The series window country. */
  country: string;
  requirements: readonly RequirementInput[];
  covers: readonly ManualCoverInput[];
  upstream: 'read' | 'not_connected' | 'league_not_selected';
  /** Professors whose listing failed. */
  unread: readonly UnreadProfessor[];
  /** play-tools' series, or null when they couldn't be read. */
  series: readonly SeriesInput[] | null;
  /** The league's tournaments in play-tools, already deduplicated. */
  listed: readonly ListedInput[];
  /** Planned tournaments the app may still create. */
  planned: readonly PlannedInput[];
}

export type CoverageStatus = 'sanctioned' | 'covered_manual' | 'pending' | 'planned' | 'problem' | 'missing' | 'unknown';
export type Urgency = 'open' | 'at_risk' | 'short_notice' | 'last_chance' | 'missed';
export type TournamentClass = 'sanctioned' | 'pending' | 'planned' | 'problem';

export interface CoveringTournament {
  tournamentId: string | null;
  plannedId: number | null;
  displayId: string | null;
  localDate: LocalDate;
  class: TournamentClass;
  upstreamStatus: string | null;
  organizer: OrganizerRef | null;
}

export type CoverageAction = { kind: 'plan' } | { kind: 'create'; plannedId: number } | { kind: 'open_in_play_tools'; tournamentId: string } | null;

export interface PeriodCoverage {
  periodStart: LocalDate;
  periodEnd: LocalDate;
  latestDate: LocalDate;
  sanctionBy: LocalDate;
  /** The matching window with the latest end that overlaps the period. */
  seriesWindow: { seriesId: string; name: string; from: LocalDate; to: LocalDate } | null;
  /** Series were read and no matching window overlaps the period. */
  noSeries: boolean;
  status: CoverageStatus;
  bestKnown: Exclude<CoverageStatus, 'unknown'> | null;
  urgency: Urgency | null;
  tournaments: CoveringTournament[];
  manualCover: Omit<ManualCoverInput, 'requirementId'> | null;
  unreadProfessors: UnreadProfessor['professor'][];
  unreadTournaments: { tournamentId: string; displayId: string | null }[];
  unjudgedPlanned: number[];
  action: CoverageAction;
}

export interface RequirementCoverage {
  requirementId: number;
  periods: PeriodCoverage[];
}

/** The league sanctions a tournament this many days before it is held: a guideline (ADR-0010 decision 6). */
const SANCTION_LEAD_DAYS = 7;

const contains = (name: string, match: string) => name.toLowerCase().includes(match.trim().toLowerCase());

const IGNORED: ReadonlySet<string> = new Set(['cancelled', 'deleted', 'invalidated']);

/**
 * What a play-tools tournament counts as, from its application state (else its status; a held one is `complete`
 * with application state `sanctioned`). An unrecognised state is pending: it never passes for covered.
 */
export function classOf(t: Pick<ListedInput, 'status' | 'applicationState'>): Exclude<TournamentClass, 'planned'> | 'ignored' {
  const state = t.applicationState ?? t.status;
  if (IGNORED.has(state) || IGNORED.has(t.status)) return 'ignored';
  if (state === 'sanctioned' || state === 'complete') return 'sanctioned';
  if (state === 'sanctioning-error') return 'problem';
  return 'pending';
}

const RANK: Record<TournamentClass, number> = { sanctioned: 0, pending: 1, planned: 2, problem: 3 };

/** The first status that holds, best first (min count `m`; a manual cover yields only to `m` sanctioned). */
function statusOf(found: readonly CoveringTournament[], minCount: number, covered: boolean): Exclude<CoverageStatus, 'unknown'> {
  const n = (c: TournamentClass) => found.filter((t) => t.class === c).length;
  const [s, p, pl] = [n('sanctioned'), n('pending'), n('planned')];
  if (s >= minCount) return 'sanctioned';
  if (covered) return 'covered_manual';
  if (s + p >= minCount) return 'pending';
  if (s + p + pl >= minCount) return 'planned';
  if (n('problem') > 0) return 'problem';
  return 'missing';
}

/** The days after the latest date a tournament held then can still be sanctioned (ADR-0010 decision 6). */
const GRACE_DAYS = 2;

/** How loud an uncovered period is on `today`, counting from its latest date (ADR-0010 decision 12). */
function urgencyOf(today: LocalDate, latest: LocalDate, warnDays: number): Urgency {
  if (today > addDays(latest, GRACE_DAYS)) return 'missed';
  if (today > latest) return 'last_chance';
  if (today > addDays(latest, -SANCTION_LEAD_DAYS)) return 'short_notice';
  if (today >= addDays(latest, -warnDays)) return 'at_risk';
  return 'open';
}

/** The one-click fix for a period's (best known) status. */
function actionOf(status: Exclude<CoverageStatus, 'unknown'>, found: readonly CoveringTournament[]): CoverageAction {
  if (status === 'missing') return { kind: 'plan' };
  if (status === 'planned') {
    const first = found.filter((t) => t.class === 'planned').sort((a, b) => a.localDate.localeCompare(b.localDate))[0]!;
    return { kind: 'create', plannedId: first.plannedId! };
  }
  if (status === 'problem') return { kind: 'open_in_play_tools', tournamentId: found.find((t) => t.class === 'problem')!.tournamentId! };
  return null;
}

/** Whether a planned row counts toward a series match, doesn't, or can't be told (its organizer's series unread). */
function plannedMatch(series: PlannedSeries, match: string): 'counts' | 'no' | 'unjudged' {
  switch (series.kind) {
    case 'resolved':
      return contains(series.name, match) ? 'counts' : 'no';
    case 'fallback':
      return contains(series.match, match) ? 'counts' : 'unjudged';
    case 'unjudged':
      return 'unjudged';
    case 'none':
      return 'no';
  }
}

export function coverage(input: CoverageInput): RequirementCoverage[] {
  const listed = input.listed.flatMap((t) => {
    const cls = classOf(t);
    return cls === 'ignored' ? [] : [{ t, cls, localDate: dateIn(new Date(t.startsAt), input.timeZone) as LocalDate }];
  });

  return input.requirements.map((req) => ({
    requirementId: req.id,
    periods: periodsFor(req.cadence, input.today).map((p): PeriodCoverage => {
      const inPeriod = (date: LocalDate) => date >= p.start && date <= p.end;
      const relevantPlanned = input.planned.filter((r) => r.product === req.product && inPeriod(r.localDate));
      const found: CoveringTournament[] = [
        ...listed
          .filter(
            ({ t, localDate }) =>
              t.products.includes(req.product) && inPeriod(localDate) && t.series !== null && t.series !== 'unread' && t.series.name !== null && contains(t.series.name, req.seriesMatch),
          )
          .map(({ t, cls, localDate }) => ({
            tournamentId: t.tournamentId,
            plannedId: null,
            displayId: t.displayId,
            localDate,
            class: cls,
            upstreamStatus: t.applicationState ?? t.status,
            organizer: t.organizer,
          })),
        ...relevantPlanned
          .filter((r) => plannedMatch(r.series, req.seriesMatch) === 'counts')
          .map((r) => ({ tournamentId: null, plannedId: r.plannedId, displayId: null, localDate: r.localDate, class: 'planned' as const, upstreamStatus: null, organizer: r.organizer })),
      ].sort((a, b) => RANK[a.class] - RANK[b.class] || a.localDate.localeCompare(b.localDate));
      const cover = input.covers.find((c) => c.requirementId === req.id && c.periodStart === p.start);
      const known = statusOf(found, req.minCount, cover !== undefined);

      // A failed read can hide a cover, so it never shows as missing; a cover that was seen stands (#102).
      const unreadTournaments = listed
        .filter(({ t, localDate }) => t.series === 'unread' && t.products.includes(req.product) && inPeriod(localDate))
        .map(({ t }) => ({ tournamentId: t.tournamentId, displayId: t.displayId }));
      const unjudgedPlanned = relevantPlanned.filter((r) => plannedMatch(r.series, req.seriesMatch) === 'unjudged').map((r) => r.plannedId);
      const settled = known === 'sanctioned' || known === 'covered_manual';
      const unsure = input.upstream !== 'read' || input.unread.length > 0 || unreadTournaments.length > 0 || unjudgedPlanned.length > 0;
      const status: CoverageStatus = !settled && unsure ? 'unknown' : known;

      const windows = (input.series ?? [])
        .filter((s) => s.product === req.product && contains(s.name, req.seriesMatch))
        .flatMap((s) => {
          const w = s.windows[input.country];
          return w && w.from <= p.end && w.to >= p.start ? [{ seriesId: s.id, name: s.name, from: w.from, to: w.to }] : [];
        })
        .sort((a, b) => b.to.localeCompare(a.to));
      const seriesWindow = windows[0] ?? null;
      const latestDate = seriesWindow && seriesWindow.to < p.end ? seriesWindow.to : p.end;
      return {
        periodStart: p.start,
        periodEnd: p.end,
        latestDate,
        sanctionBy: addDays(latestDate, -SANCTION_LEAD_DAYS),
        seriesWindow,
        noSeries: input.series !== null && seriesWindow === null,
        status,
        bestKnown: status === 'unknown' ? known : null,
        urgency: settled ? null : urgencyOf(input.today, latestDate, req.warnDays),
        tournaments: found,
        manualCover: cover ? { periodStart: cover.periodStart, note: cover.note, createdBy: cover.createdBy, createdAt: cover.createdAt } : null,
        unreadProfessors: status === 'unknown' ? input.unread.map((u) => u.professor) : [],
        unreadTournaments: status === 'unknown' ? unreadTournaments : [],
        unjudgedPlanned: status === 'unknown' ? unjudgedPlanned : [],
        action: actionOf(status === 'unknown' ? known : status, found),
      };
    }),
  }));
}
