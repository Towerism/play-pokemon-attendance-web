/**
 * Spike S8 part 2 (#85): the decisions behind `spikes/s8-live.ts`, kept pure so
 * they can be tested. A wrong call here means a wrong or duplicate real
 * tournament, so every guard lives here, not in the CLI glue.
 */
import { createHash } from 'node:crypto';

export type Product = 'tcg' | 'vg' | 'pgo';
export const PRODUCTS: readonly Product[] = ['tcg', 'vg', 'pgo'];

export interface PlanTemplate {
  activity_group_id: string;
  /** The organizer's user guid. */
  organizer_id: string;
  /** The league's own address-book entry. */
  address_id: string;
  /** The venue's IANA zone: `local_start` is read in it. */
  timezone: string;
  contact_information: { email?: string; phone?: string };
}

export interface PlanEvent {
  name: string;
  product: Product;
  category: string;
  series_guid: string | null;
  /** Wall-clock start at the venue, `YYYY-MM-DDTHH:mm`. */
  local_start: string;
  details?: string;
  activity_division_info?: unknown;
}

export interface SeriesRef {
  guid: string;
  product: string;
  category_slugs: string[];
  window: { start_date?: string; end_date?: string } | null;
}

export interface Plan {
  template: PlanTemplate;
  /** Category slugs per product, from `core/products`. */
  categories: Partial<Record<Product, string[]>>;
  /** For reference only (ADR-0010 Q8); this run creates no premier event. */
  series: SeriesRef[];
  events: PlanEvent[];
}

export interface PlanProblem {
  index: number | 'plan';
  field: string;
  message: string;
}

const MAX_NAME = 80;
const MAX_DETAILS = 30_000;
const MAX_BACKDATE_MS = 72 * 3_600_000;
const LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const EMOJI = /\p{Extended_Pictographic}/u;

/** Every problem in the plan; empty means it may be sent. Organizer decision 1: exactly one custom event. */
export function validatePlan(plan: Plan, ctx: { now: Date }): PlanProblem[] {
  const problems: PlanProblem[] = [];
  if (plan.events.length !== 1) {
    problems.push({ index: 'plan', field: 'events', message: `This run creates exactly one event, not ${plan.events.length}` });
  }
  const { email, phone } = plan.template.contact_information;
  plan.events.forEach((e, index) => {
    const add = (field: string, message: string) => problems.push({ index, field, message });
    const name = e.name.trim();
    if (!name) add('name', 'Name is empty');
    else if (e.name.length > MAX_NAME) add('name', `Name is ${e.name.length} characters (at most ${MAX_NAME})`);
    else if (EMOJI.test(e.name)) add('name', 'Name contains an emoji');
    if (!PRODUCTS.includes(e.product)) add('product', `Unknown product "${e.product}"`);
    else if (!(plan.categories[e.product] ?? []).includes(e.category)) add('category', `"${e.category}" is not a ${e.product} category`);
    if (e.series_guid !== null) add('series_guid', 'This run creates a custom event only (series_guid must be null)');
    if (!LOCAL.test(e.local_start)) add('local_start', 'Start must be YYYY-MM-DDTHH:mm');
    else if (ctx.now.getTime() - Date.parse(localToUtc(e.local_start, plan.template.timezone)) > MAX_BACKDATE_MS) {
      add('local_start', 'Start is more than 72 h in the past');
    }
    if ((e.details ?? '').length > MAX_DETAILS) add('details', `Details are over ${MAX_DETAILS} characters`);
    if (!email && !phone) add('contact_information', 'Needs a contact email or phone');
  });
  return problems;
}

/** Wall-clock offset of `zone` at `instant`, in ms (UTC + offset = local). */
function offsetAt(instant: number, zone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(instant))
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<string, number>;
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) - instant;
}

/** `YYYY-MM-DDTHH:mm` at the venue → UTC ISO without milliseconds. */
export function localToUtc(local: string, zone: string): string {
  const [date, time] = local.split('T') as [string, string];
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  let instant = asUtc - offsetAt(asUtc, zone);
  instant = asUtc - offsetAt(instant, zone);
  return new Date(instant).toISOString().replace('.000Z', 'Z');
}

export interface CreateBody {
  name: string;
  activity_group_id: string;
  organizer_id: string;
  product: Product;
  category: string;
  series_guid: string | null;
  address_id: string;
  start_date_v2?: string;
  start_date?: string;
  on_site_registration_datetime_full?: string;
  on_site_registration_duration?: number;
  contact_information: { email?: string; phone?: string };
  details?: string;
  activity_division_info: unknown;
}

export type DateFormat = 'v2' | 'naive';
const NAIVE_REGISTRATION_MINUTES = 30;

/** `toApiTournamentPayload`'s field names (S8 part 1). */
export function createBody(e: PlanEvent, t: PlanTemplate, fmt: DateFormat): CreateBody {
  const dates: Partial<CreateBody> = fmt === 'v2' ? { start_date_v2: localToUtc(e.local_start, t.timezone) } : naiveDates(e.local_start);
  return {
    name: e.name,
    activity_group_id: t.activity_group_id,
    organizer_id: t.organizer_id,
    product: e.product,
    category: e.category,
    series_guid: e.series_guid,
    address_id: t.address_id,
    ...dates,
    contact_information: t.contact_information,
    ...(e.details !== undefined ? { details: e.details } : {}),
    activity_division_info: e.activity_division_info ?? null,
  };
}

function naiveDates(local: string): Partial<CreateBody> {
  // Naive local strings: shifting through UTC keeps the wall clock as written.
  const start = Date.parse(`${local}:00Z`);
  const naive = (ms: number) => new Date(ms).toISOString().slice(0, 19);
  return {
    start_date: naive(start),
    on_site_registration_datetime_full: naive(start - NAIVE_REGISTRATION_MINUTES * 60_000),
    on_site_registration_duration: NAIVE_REGISTRATION_MINUTES,
  };
}

/** A plan's code covers its exact bytes: an edit after the dry run needs a new code. */
export function confirmCode(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(-6);
}

/** The fields of `GET core/tournament/{guid}` the guards read (S6, S8 part 1). */
export interface TournamentDetail {
  guid: string;
  display_id: string;
  product: string;
  application_state?: string;
  status?: string;
  activity_state?: string;
  start_date_v2?: string;
  start_date_actual?: string;
  details?: string | null;
  organizer?: { player_id?: string; guid?: string };
  contact_information?: { email?: string; phone?: string };
}

export interface Ledger {
  created: { guid: string }[];
}

const CANCELLABLE = ['sanctioned', 'approval-pending', 'sanctioning-error'];
const EDIT_WINDOW_MS = 90 * 86_400_000;

const stateOf = (t: TournamentDetail) => t.application_state ?? t.status ?? '';
const startOf = (t: TournamentDetail) => Date.parse(t.start_date_actual ?? t.start_date_v2 ?? '');

/** Why this tournament must not be cancelled, or null. */
export function cancelRefusal(t: TournamentDetail, ledger: Ledger, now: Date): string | null {
  if (ledger.created.some((c) => c.guid === t.guid)) return 'It is in the ledger: the run keeps it for the TDF upload';
  if (!CANCELLABLE.includes(stateOf(t))) return `application_state is "${stateOf(t)}", not one of ${CANCELLABLE.join(', ')}`;
  if (t.activity_state === 'completed') return 'activity_state is "completed": its results are uploaded';
  if (!(now.getTime() <= startOf(t) + EDIT_WINDOW_MS)) return 'It is more than 90 days after its start';
  return null;
}

/** Why this TDF must not be sent for this tournament, or null. */
export function tdfMismatch(
  header: { tournamentId: string; organizerId: string; gametype: string },
  t: TournamentDetail,
  playerRecords: number,
  expectedGametype: string,
): string | null {
  if (header.tournamentId !== t.display_id) return `The file's tournament id is ${header.tournamentId}, not ${t.display_id}`;
  if (header.organizerId !== t.organizer?.player_id) return "The file's organizer is not the tournament's organizer";
  if (header.gametype !== expectedGametype) return `The file's gametype is ${header.gametype}, expected ${expectedGametype} for ${t.product}`;
  if (stateOf(t) !== 'sanctioned') return `The tournament is "${stateOf(t)}", not sanctioned`;
  if (t.activity_state !== 'pending') return `The tournament's activity_state is "${t.activity_state}", not pending`;
  if (playerRecords > 0) return 'The tournament already has a player record; an organizer cannot upload over it';
  return null;
}

/** The PATCH that puts `details` and the start back as in the snapshot, or null. */
export function restoreActions(snapshot: TournamentDetail, current: TournamentDetail): Partial<CreateBody> | null {
  const out: Partial<CreateBody> = {};
  if ((current.details ?? '') !== (snapshot.details ?? '')) out.details = snapshot.details ?? '';
  if (Date.parse(current.start_date_v2 ?? '') !== Date.parse(snapshot.start_date_v2 ?? '')) out.start_date_v2 = snapshot.start_date_v2;
  return Object.keys(out).length ? out : null;
}

export interface TemplateInput {
  leagueGuid: string;
  now: Date;
  products: unknown;
  series: unknown;
  addressBook: unknown;
  detail: TournamentDetail;
}

type Row = Record<string, unknown>;
const rows = (v: unknown): Row[] => {
  if (Array.isArray(v)) return v as Row[];
  const results = (v as Row | null)?.results;
  return Array.isArray(results) ? (results as Row[]) : [];
};
const slugOf = (c: unknown) => (typeof c === 'string' ? c : String((c as Row | null)?.slug ?? ''));

/** The plan `reads` writes: everything but the event's name. */
export function buildTemplate(input: TemplateInput): Plan {
  const book = rows(input.addressBook);
  const home = book.find((a) => /activity_group|league/i.test(String(a.source ?? ''))) ?? book[0] ?? {};
  const timezone = String(home.timezone ?? '');
  const country = String(home.country ?? 'US');

  const byProduct = ((input.products as Row | null)?.product_categories ?? {}) as Record<string, unknown[]>;
  const categories: Partial<Record<Product, string[]>> = {};
  for (const p of PRODUCTS) if (byProduct[p]) categories[p] = byProduct[p].map(slugOf).filter(Boolean);
  const tcg = categories.tcg ?? [];

  const series: SeriesRef[] = rows(input.series).map((s) => ({
    guid: String(s.guid ?? ''),
    product: String(s.product ?? ''),
    category_slugs: Array.isArray(s.category_slugs) ? s.category_slugs.map(String) : [],
    window: (s.schedule as Record<string, SeriesRef['window']> | undefined)?.[country] ?? null,
  }));

  return {
    template: {
      activity_group_id: input.leagueGuid,
      organizer_id: input.detail.organizer?.guid ?? '',
      address_id: String(home.guid ?? ''),
      timezone,
      contact_information: input.detail.contact_information ?? {},
    },
    categories,
    series,
    events: [
      {
        name: '',
        product: 'tcg',
        category: tcg.includes('tcg_std') ? 'tcg_std' : (tcg[0] ?? ''),
        series_guid: null,
        local_start: utcToLocalHour(input.now.getTime() - 86_400_000, timezone),
      },
    ],
  };
}

/** The instant at the venue, rounded down to the hour, as `YYYY-MM-DDTHH:00`. */
function utcToLocalHour(instant: number, zone: string): string {
  return `${new Date(instant + offsetAt(instant, zone)).toISOString().slice(0, 13)}:00`;
}
