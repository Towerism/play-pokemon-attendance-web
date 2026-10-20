import { clientKey } from '@towerism/selfhost-kit';
import type { H3Event } from 'h3';
import { type CalendarService, type ServeAnswer, createCalendarService } from '../modules/calendar/service';
import { type PlaySessionLister, createPlaySessionLister } from '../modules/submission/play-sessions';

let calendar: CalendarService | undefined;
let lister: PlaySessionLister | undefined;

/** Calendar feeds (ADR-0016): the public feed and each user's own, served from the league's snapshot. */
export function useCalendar(): CalendarService {
  calendar ??= createCalendarService({
    db: useDb(),
    tournaments: useTournaments(),
    sessions: usePlaySessionLister(),
    staffing: useStaffing(),
    leases: useLeases(),
    connections: usePokemon(),
    accounts: useAccounts(),
    timeZone: leagueTimeZone(),
    log: useLogger('calendar'),
  });
  return calendar;
}

/** The league's play sessions in a range, for the calendar refresh: read as the reading connection (ADR-0015 §4). */
export function usePlaySessionLister(): PlaySessionLister {
  lister ??= createPlaySessionLister({ connections: usePokemon(), gateway: connectionGateway });
  return lister;
}

/** Where a new feed link works (ADR-0016 §6): on the internet, maybe on the internet, or only on the local network. */
export type CalendarReach = 'internet' | 'site_url' | 'local_only';

/** A refused fetch: always an empty body, so a guess learns nothing (ADR-0016 §4). */
class CalendarRefusal extends Error {
  constructor(
    readonly status: 404 | 429 | 503,
    readonly retryAfterSeconds: number | null,
  ) {
    super(`calendar feed refused (${status})`);
  }
}

/** How long a client waits after a temporary refusal: one hourly refresh. */
const RETRY_AFTER_SECONDS = 3600;

/**
 * The only guard of the feed route (ADR-0016 §4): the secret in `token`, and nothing else. A session cookie, an
 * integration token or an `Authorization` header is never read. A secret that matches no feed counts against the
 * client's refusal limit; a matching one against the fetch limit for that client and feed.
 * @throws CalendarRefusal, which `answerCalendarFeed` turns into an empty 404, 429 or 503
 */
export async function requireCalendarFeed(event: H3Event): Promise<Extract<ServeAnswer, { kind: 'ok' }>> {
  const raw = getQuery(event).token;
  // A repeated parameter arrives as an array: malformed, like any other value that isn't one secret.
  const secret = typeof raw === 'string' ? raw : null;
  const { calendar: limits, trusted } = useRateLimits();
  const client = clientKey({ remoteAddress: getRequestIP(event), xForwardedFor: getRequestHeader(event, 'x-forwarded-for'), trusted });

  const feedId = useCalendar().matchFeed(secret);
  if (feedId === null) {
    const hit = limits.refusal.hit(client);
    throw new CalendarRefusal(hit.allowed ? 404 : 429, hit.allowed ? null : hit.retryAfterSeconds);
  }
  const hit = limits.fetch.hit(`${client}:${feedId}`);
  if (!hit.allowed) throw new CalendarRefusal(429, hit.retryAfterSeconds);

  const answer = await useCalendar().serve(secret);
  if (answer.kind === 'refused') throw new CalendarRefusal(answer.reason === 'permanent' ? 404 : 503, answer.reason === 'permanent' ? null : RETRY_AFTER_SECONDS);
  return answer;
}

/**
 * Answers the feed route. Every error is caught here, so none reaches Nitro's error handler, which would log the
 * request URL with the secret in it (ADR-0016 §4): a refusal is its empty status, anything else an empty 503.
 */
export async function answerCalendarFeed(event: H3Event, guard: () => Promise<Extract<ServeAnswer, { kind: 'ok' }>>): Promise<string> {
  try {
    const feed = await guard();
    setResponseHeaders(event, {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Cache-Control': 'private, max-age=300',
      ETag: feed.etag,
      'X-Robots-Tag': 'noindex',
    });
    const wanted = (getRequestHeader(event, 'if-none-match') ?? '').split(',').map((s) => s.trim());
    if (wanted.includes(feed.etag)) {
      setResponseStatus(event, 304);
      return '';
    }
    return feed.body;
  } catch (err) {
    if (err instanceof CalendarRefusal) {
      setResponseStatus(event, err.status);
      if (err.retryAfterSeconds !== null) setResponseHeader(event, 'Retry-After', err.retryAfterSeconds);
      return '';
    }
    // Never the URL or the query: the secret is in it.
    useLogger('calendar').warn('calendar feed fetch failed', { code: errorCode(err) });
    setResponseStatus(event, 503);
    setResponseHeader(event, 'Retry-After', RETRY_AFTER_SECONDS);
    return '';
  }
}

/** Where a feed link works, from how the install is configured (ADR-0016 §6). */
export function calendarReach(): CalendarReach {
  const config = useRuntimeConfig();
  if (config.calendarBaseUrl) return isHttps(config.calendarBaseUrl) ? 'internet' : 'local_only';
  if (config.public.siteUrl) return isHttps(config.public.siteUrl) ? 'site_url' : 'local_only';
  return 'local_only';
}

/**
 * A feed's link, from `NUXT_CALENDAR_BASE_URL`, else `NUXT_PUBLIC_SITE_URL`, else the origin of the Settings request
 * that asked for it, with forwarded headers ignored (ADR-0016 §1).
 */
export function calendarLink(event: H3Event, secret: string): { url: string; webcalUrl: string; reach: CalendarReach } {
  const config = useRuntimeConfig();
  const base = String(config.calendarBaseUrl || config.public.siteUrl || getRequestURL(event, { xForwardedHost: false, xForwardedProto: false }).origin).replace(
    /\/+$/,
    '',
  );
  const url = `${base}/api/calendar/v1/feed.ics?token=${secret}`;
  return { url, webcalUrl: url.replace(/^https?:\/\//i, 'webcal://'), reach: calendarReach() };
}

const isHttps = (url: unknown) => typeof url === 'string' && /^https:\/\//i.test(url);

function errorCode(err: unknown): string {
  if (typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string') return (err as { code: string }).code;
  return err instanceof Error ? err.name : 'unknown';
}
