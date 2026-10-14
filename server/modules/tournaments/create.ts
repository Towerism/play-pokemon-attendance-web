import type { NewTournament, Product, Tournament } from '../pokemon/ports/play-tools-gateway';
import { addDays, type LocalDate } from './dates';
import type { PlannedRowState } from './plan';
import type { TemplateSettings } from './settings';

const MINUTE_MS = 60_000;

/**
 * What a planned tournament is created as in play-tools: its resolved settings at its start instant. An on-site
 * registration opens and closes its minutes around the start; a third-party one is only its URL. Pure.
 */
export function newTournament(
  settings: TemplateSettings,
  at: { startsAt: Date; groupId: string; product: Product; seriesId: string | null },
): NewTournament {
  const { registration } = settings;
  const start = at.startsAt.getTime();
  return {
    name: settings.name,
    groupId: at.groupId,
    product: at.product,
    category: settings.category,
    seriesId: at.seriesId,
    venueId: settings.venue.id,
    startsAt: at.startsAt,
    contact: { email: settings.contactEmail, phone: settings.contactPhone },
    ...(registration.kind === 'on_site'
      ? {
          registration: { startsAt: new Date(start - registration.opensBeforeMin * MINUTE_MS), endsAt: new Date(start + registration.closesAfterMin * MINUTE_MS) },
          onSiteAdmission: registration.admission,
        }
      : { registration: null, thirdPartyRegistrationUrl: registration.url }),
    details: settings.details,
    eventWebsite: settings.eventWebsite,
  };
}

/** Upstream statuses that no longer hold a tournament: never adopted (ADR-0010 decision 5). */
const DEAD = new Set(['cancelled', 'deleted', 'invalidated']);

/** What a planned tournament would be created as, for matching against play-tools. */
export interface AdoptionTarget {
  startsAt: Date;
  product: string;
  /** With its tokens filled. */
  name: string;
  /** The league's activity group. */
  groupId: string;
}

const normalized = (name: string) => name.trim().toLowerCase();

/**
 * The listed tournaments a planned one may adopt instead of being created (ADR-0010 decision 5, #100): live,
 * the same start, product, league and name (trimmed, any case), and held by no planned row yet. The format
 * isn't in a listing: the caller compares it from each candidate's details, in this order (by guid). Pure.
 */
export function adoptionCandidates(target: AdoptionTarget, listed: readonly Tournament[], linked: ReadonlySet<string>): Tournament[] {
  return listed
    .filter(
      (t) =>
        !DEAD.has(t.status) &&
        !linked.has(t.id) &&
        t.groupId === target.groupId &&
        t.startsAt?.getTime() === target.startsAt.getTime() &&
        t.products.includes(target.product) &&
        t.name !== null &&
        normalized(t.name) === normalized(target.name),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Held from today through 6 days ahead: less than the 7 days the league is expected to sanction ahead (ADR-0010 decision 6). */
export function isShortNotice(localDate: LocalDate, today: LocalDate): boolean {
  return localDate >= today && localDate <= addDays(today, 6);
}

/** Why **Create through date…** leaves a row out. */
export type LeftOutReason = 'skipped' | 'in_play_tools' | 'creating' | 'unknown' | 'before_window';

export interface ThroughRow {
  id: number;
  localDate: LocalDate;
  state: PlannedRowState;
  /** The start instant (ISO) when known, else the local start: only orders rows. */
  startsAt: string;
}

/** The most one create job takes (ADR-0010 decision 5). */
export const MAX_CREATE = 60;

const LEFT_OUT: Partial<Record<PlannedRowState, LeftOutReason>> = {
  skipped: 'skipped',
  created: 'in_play_tools',
  creating: 'creating',
  unknown: 'unknown',
};

/**
 * What **Create through date…** creates from one schedule's rows (ADR-0010 decision 5): `planned` and `failed` rows
 * whose local date is on or before `through`, in start order, with the rest listed as left out. Over 60 is too
 * many: it suggests the latest date whose rows still fit. Cancelled rows aren't mentioned. Pure.
 */
export function selectCreateThrough<R extends ThroughRow>(rows: readonly R[], range: { windowStart: LocalDate; through: LocalDate }) {
  const inRange = rows
    .filter((r) => r.localDate <= range.through && r.state !== 'cancelled')
    .sort((a, b) => a.localDate.localeCompare(b.localDate) || a.startsAt.localeCompare(b.startsAt) || a.id - b.id);
  const tournaments: R[] = [];
  const leftOut: { row: R; reason: LeftOutReason }[] = [];
  for (const r of inRange) {
    if (r.localDate < range.windowStart) leftOut.push({ row: r, reason: 'before_window' });
    else if (r.state === 'planned' || r.state === 'failed') tournaments.push(r);
    else leftOut.push({ row: r, reason: LEFT_OUT[r.state]! });
  }
  const tooMany = tournaments.length > MAX_CREATE;
  let suggestedThrough: LocalDate | null = null;
  if (tooMany) {
    // The cut can't split a date: the day of the 61st is left out whole.
    const firstOver = tournaments[MAX_CREATE]!.localDate;
    const fitting = tournaments.filter((r) => r.localDate < firstOver);
    suggestedThrough = fitting.at(-1)?.localDate ?? null;
  }
  return { tournaments, leftOut, count: tournaments.length, tooMany, suggestedThrough };
}
