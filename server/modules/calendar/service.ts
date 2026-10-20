import { createHash } from 'node:crypto';
import { type Logger, silentLogger } from '@towerism/selfhost-kit';
import { eq } from 'drizzle-orm';
import { addDays } from '../../../shared/requirements/periods';
import { dateIn, localDay } from '../../../shared/time/local-time';
import type { SessionDate } from '../../../shared/types/ids';
import type { Db } from '../../db/client';
import { calendarSnapshot } from '../../db/schema';
import type { Actor } from '../accounts/service';
import type { PokemonConnectionService } from '../pokemon/connection';
import type { LeaseService } from '../pokemon/leases';
import { PokemonUpstreamError } from '../pokemon/ports/errors';
import type { StaffingService } from '../staffing/service';
import type { PlaySessionLister } from '../submission/play-sessions';
import type { CalendarCheck, TournamentsService } from '../tournaments/service';
import { type FeedRef, type FeedStore, type FeedView, createFeedStore } from './feeds';
import { writeCalendar } from './ical';
import { type SessionsRead, dropOuts, merge } from './merge';
import { type FeedAudience, projectFeed, staleSources } from './project';
import { type Snapshot, sourcePlayerId } from './snapshot';

/**
 * Calendar feeds (ADR-0016): the league's public feed and each user's own, served from one stored snapshot per league.
 * A fetch never calls play-tools. The snapshot is refreshed hourly while a feed is in use, when a feed is turned on or
 * rotated, and rebuilt locally when the app changes a tournament; one writer at a time per league.
 */

export type FeedKind = 'public' | 'user';

export interface CalendarFeedsView {
  me: FeedView | null;
  /** The owner's only. */
  public?: FeedView | null;
  snapshot: { builtAt: string | null; staleSources: { name: string | null; lastReadAt: string | null }[] };
}

/** What a fetch answers. A permanent refusal is a 404, a temporary one a 503 (ADR-0016 §4). */
export type ServeAnswer =
  | { kind: 'refused'; reason: 'permanent' | 'temporary'; matched: boolean }
  | { kind: 'ok'; feedId: number; feedKind: FeedKind; body: string; etag: string; events: number; snapshotAgeSeconds: number };

export interface CalendarService {
  /** The caller's own feed, the public feed for the owner, and the snapshot's age and stale sources. */
  feeds(leagueId: string, actor: Actor): CalendarFeedsView;
  /**
   * Turns a feed on or rotates it, refreshing the snapshot first unless it was refreshed under 5 minutes ago. The secret
   * is returned here only. The caller checks that only the owner mints the public feed.
   */
  mint(leagueId: string, actor: Actor, kind: FeedKind): Promise<{ secret: string; feed: FeedView; created: boolean }>;
  turnOff(leagueId: string, actor: Actor, kind: FeedKind): void;
  /** A removed professor's feeds; inside the removal's transaction. */
  deleteUserFeeds(userId: number): void;
  /** Answers a fetch from the snapshot. Never calls play-tools. */
  serve(secret: string | null | undefined): Promise<ServeAnswer>;
  /** A full refresh; one per league at a time, and a request while one runs gets that one. */
  refresh(leagueId: string): Promise<void>;
  /** Rebuilds the local part (planned rows) with no play-tools call; does nothing before the first refresh. */
  rebuildLocal(leagueId: string): Promise<void>;
  /** Leagues the hourly task refreshes: a feed read, created or rotated in the last 48 hours. */
  refreshDue(): string[];
}

export interface CalendarDeps {
  db: Db;
  tournaments: Pick<TournamentsService, 'calendarEvents' | 'checkTournament'>;
  sessions: PlaySessionLister;
  staffing: Pick<StaffingService, 'liveAssignmentsFor'>;
  leases: Pick<LeaseService, 'liveLeasesFor'>;
  connections: Pick<PokemonConnectionService, 'league' | 'listActingConnections' | 'listReadableConnections'>;
  /** The user behind a feed: null once removed. */
  accounts: { actor(userId: number): Actor | null };
  /** The league time zone (ADR-0006). */
  timeZone: string;
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
  log?: Pick<Logger, 'info' | 'warn'>;
}

const MINUTE = 60_000;
/** A new or rotated feed reuses a snapshot refreshed this recently. */
const FRESH_MS = 5 * MINUTE;
/** The hourly refresh runs only for a league whose feeds were used this recently. */
const IN_USE_MS = 48 * 60 * MINUTE;
/** ADR-0016 §2: from 30 days back to 26 weeks ahead. */
const DAYS_BACK = 30;
const DAYS_AHEAD = 26 * 7;

export function createCalendarService(deps: CalendarDeps): CalendarService {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? silentLogger;
  const store: FeedStore = createFeedStore({ db, now, ...(deps.randomBytes && { randomBytes: deps.randomBytes }) });

  const refOf = (actor: Actor, kind: FeedKind): FeedRef => (kind === 'public' ? { kind: 'public' } : { kind: 'user', userId: actor.userId });

  function load(leagueId: string): Snapshot | null {
    const row = db.select().from(calendarSnapshot).where(eq(calendarSnapshot.leagueId, leagueId)).get();
    return row ? { builtAt: row.builtAt.toISOString(), events: row.events as Snapshot['events'], sources: row.sources as Snapshot['sources'] } : null;
  }

  function save(leagueId: string, s: Snapshot) {
    const values = { builtAt: new Date(s.builtAt), events: s.events, sources: s.sources };
    db.insert(calendarSnapshot)
      .values({ leagueId, ...values })
      .onConflictDoUpdate({ target: calendarSnapshot.leagueId, set: values })
      .run();
  }

  /** The days a refresh reads and a feed shows, from today in the league's time zone. */
  function rangeAt(at: Date) {
    const today = dateIn(at, deps.timeZone);
    const from = addDays(today, -DAYS_BACK);
    const to = addDays(today, DAYS_AHEAD);
    return {
      dates: { from, to },
      instants: { from: localDay(from as SessionDate, deps.timeZone).from, to: localDay(to as SessionDate, deps.timeZone).to },
    };
  }

  /** Sources whose professor no connection in the league has any more (disconnected, removed or outside). */
  function goneSources(s: Snapshot): Set<string> {
    const present = new Set(deps.connections.listReadableConnections().flatMap((c) => (c.professorPlayerId ? [c.professorPlayerId] : [])));
    return new Set(s.sources.flatMap((x) => (sourcePlayerId(x.key) !== null && !present.has(sourcePlayerId(x.key)!) ? [x.key] : [])));
  }

  /** When the last full refresh tried every source: the latest attempt any source records. */
  function lastRefreshAt(s: Snapshot | null): number | null {
    const attempts = (s?.sources ?? []).flatMap((x) => (x.lastAttemptAt ? [new Date(x.lastAttemptAt).getTime()] : []));
    return attempts.length === 0 ? null : Math.max(...attempts);
  }

  async function runRefresh(leagueId: string): Promise<void> {
    const at = now();
    const range = rangeAt(at);
    const read = await deps.tournaments.calendarEvents(leagueId, range.dates, 'refresh');
    let sessions: SessionsRead;
    try {
      sessions = { ok: true, sessions: await deps.sessions.listPlaySessionsInRange(leagueId, range.instants) };
    } catch (err) {
      sessions = { ok: false, code: err instanceof PokemonUpstreamError || isCoded(err) ? (err as { code: string }).code : 'error' };
    }
    for (const f of read.failed) log.warn('calendar refresh could not read a source', { source: `professor:${f.playerId ?? 'unidentified'}`, code: f.code });
    if (!sessions.ok) log.warn('calendar refresh could not read a source', { source: 'sessions', code: sessions.code });

    const previous = load(leagueId);
    const checks = new Map<string, CalendarCheck>();
    for (const { tournamentId, playerId } of dropOuts(previous, read, range.instants)) {
      try {
        checks.set(tournamentId, await deps.tournaments.checkTournament(leagueId, playerId, tournamentId));
      } catch (err) {
        log.warn('calendar refresh could not check a tournament', { tournamentId, code: isCoded(err) ? err.code : 'error' });
      }
    }
    const names = new Map(deps.connections.listActingConnections().flatMap((c) => (c.professorPlayerId ? [[c.professorPlayerId, c.professorName] as const] : [])));
    db.transaction(() => {
      // Read again inside the write: a queued writer never works from a snapshot another has replaced.
      const latest = load(leagueId);
      save(leagueId, merge(latest, { leagueId, now: at, range: range.instants, read, sessions, checks, names }));
    });
  }

  async function runLocal(leagueId: string): Promise<void> {
    if (!load(leagueId)) return;
    const at = now();
    const range = rangeAt(at);
    const read = await deps.tournaments.calendarEvents(leagueId, range.dates, 'local');
    db.transaction(() => {
      const latest = load(leagueId);
      if (latest) save(leagueId, merge(latest, { leagueId, now: at, range: range.instants, read, sessions: null, checks: new Map(), names: new Map() }));
    });
  }

  /** One writer at a time per league; a request that a queued or running job already covers gets that job. */
  type Job = { kind: 'refresh' | 'local'; promise: Promise<void> };
  const lanes = new Map<string, { tail: Promise<void>; running: Job | null; queued: Job[] }>();

  function enqueue(leagueId: string, kind: Job['kind']): Promise<void> {
    let lane = lanes.get(leagueId);
    if (!lane) lanes.set(leagueId, (lane = { tail: Promise.resolve(), running: null, queued: [] }));
    const l = lane;
    const covered = l.queued.find((j) => j.kind === kind) ?? (kind === 'refresh' && l.running?.kind === 'refresh' ? l.running : undefined);
    if (covered) return covered.promise;
    const job = { kind } as Job;
    job.promise = l.tail
      .then(async () => {
        l.queued = l.queued.filter((j) => j !== job);
        l.running = job;
        try {
          await (kind === 'refresh' ? runRefresh(leagueId) : runLocal(leagueId));
        } catch (err) {
          log.warn(`calendar ${kind === 'refresh' ? 'refresh' : 'rebuild'} failed: ${(err as Error).message}`, { leagueId });
        }
      })
      .finally(() => {
        if (l.running === job) l.running = null;
      });
    l.queued.push(job);
    l.tail = job.promise;
    return job.promise;
  }

  return {
    feeds(leagueId, actor) {
      const snapshot = load(leagueId);
      return {
        me: store.view(leagueId, refOf(actor, 'user')),
        ...(actor.role === 'owner' && { public: store.view(leagueId, { kind: 'public' }) }),
        snapshot: {
          builtAt: snapshot?.builtAt ?? null,
          staleSources: snapshot ? staleSources(snapshot, { now: now(), goneSources: goneSources(snapshot) }).map(({ name, lastReadAt }) => ({ name, lastReadAt })) : [],
        },
      };
    },

    async mint(leagueId, actor, kind) {
      const minted = store.mint(leagueId, refOf(actor, kind));
      const last = lastRefreshAt(load(leagueId));
      if (last === null || now().getTime() - last >= FRESH_MS) await enqueue(leagueId, 'refresh');
      return minted;
    },

    turnOff(leagueId, actor, kind) {
      store.turnOff(leagueId, refOf(actor, kind));
    },

    deleteUserFeeds(userId) {
      store.deleteUserFeeds(userId);
    },

    async serve(secret) {
      const feed = store.find(secret);
      if (!feed) return { kind: 'refused', reason: 'permanent', matched: false };
      const refused = (reason: 'permanent' | 'temporary') => ({ kind: 'refused' as const, reason, matched: true });

      const league = deps.connections.league(feed.leagueId);
      let audience: FeedAudience = { kind: 'public' };
      if (feed.kind === 'user') {
        const actor = deps.accounts.actor(feed.userId!);
        if (!actor) return refused('permanent');
        const held = deps.connections.listActingConnections().filter((c) => c.userId === actor.userId);
        if (actor.role !== 'owner') {
          const member = held.some((c) => c.membership === 'member');
          if (actor.reverifyRequired || (!member && held.some((c) => c.membership === 'unknown'))) return refused('temporary');
          if (!member && held.length > 0) return refused('permanent');
        }
        const playerIds = new Set(held.flatMap((c) => (c.professorPlayerId ? [c.professorPlayerId] : [])));
        audience = {
          kind: 'user',
          playerIds,
          assignments: deps.staffing.liveAssignmentsFor(feed.leagueId, [...playerIds]),
          leases: deps.leases.liveLeasesFor(actor.userId),
        };
      }
      if (!league) return refused('temporary');
      const snapshot = load(feed.leagueId);
      if (!snapshot) return refused('temporary');

      const at = now();
      const calendar = projectFeed(snapshot, audience, {
        now: at,
        leagueName: league.name,
        timeZone: deps.timeZone,
        range: rangeAt(at).instants,
        goneSources: goneSources(snapshot),
      });
      const body = writeCalendar(calendar);
      store.markRead(feed.id);
      const answer = {
        kind: 'ok' as const,
        feedId: feed.id,
        feedKind: feed.kind,
        body,
        etag: `"${createHash('sha256').update(body).digest('hex')}"`,
        events: calendar.events.length,
        snapshotAgeSeconds: Math.max(0, Math.round((at.getTime() - new Date(snapshot.builtAt).getTime()) / 1000)),
      };
      log.info('calendar feed read', { feedId: answer.feedId, kind: answer.feedKind, events: answer.events, snapshotAgeSeconds: answer.snapshotAgeSeconds });
      return answer;
    },

    refresh: (leagueId) => enqueue(leagueId, 'refresh'),
    rebuildLocal: (leagueId) => enqueue(leagueId, 'local'),
    refreshDue: () => store.leaguesInUse(new Date(now().getTime() - IN_USE_MS)),
  };
}

function isCoded(err: unknown): err is { code: string } {
  return typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string';
}
