import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import type { Actor } from '../accounts/service';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import type { ActingConnection } from '../pokemon/connection';
import { PokemonUpstreamError } from '../pokemon/ports/errors';
import type { PlaySession } from '../pokemon/ports/play-tools-gateway';
import { OWNER, professorActor } from '../pokemon/test-connections';
import type { CalendarCheck, CalendarTournament } from '../tournaments/service';
import { type CalendarService, createCalendarService } from './service';
import { MISTY, OAK, calendarTournament, playSession, upstreamOnly } from './test-helpers';

// The calendar module end to end over real SQLite (ADR-0016): feeds, the refresh queue, and what a fetch answers.
// Other modules are small fakes of their exported services; play-tools is never reached.

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const TZ = 'America/Chicago';
const MISTY_USER = professorActor(2, 'misty');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let database: OpenDatabase;
let calendar: CalendarService;
let now: Date;
let serial: number;
let logs: { level: string; message: string; fields: Record<string, unknown> }[];

// What the other modules answer.
let tournaments: CalendarTournament[];
let failed: { playerId: string | null; code: string }[];
let sessions: PlaySession[] | Error;
let checks: Record<string, CalendarCheck>;
let connections: ActingConnection[];
let league: { id: string; name: string; displayId: string | null } | null;
let actors: Map<number, Actor>;
let reads: string[];
let gate: Promise<void> | null;
/** Leases by lessee user id. */
let leases: Map<number, { tournamentId: string; endsAt: Date; grantedAt: Date }[]>;
/** When set, the tournaments read throws it. */
let brokenRead: Error | null;

const conn = (id: number, userId: number, playerId: string | null, membership: ActingConnection['membership'] = 'member'): ActingConnection => ({
  id,
  professorPlayerId: playerId,
  professorName: playerId === OAK ? 'Prof Oak' : playerId === MISTY ? 'Misty' : null,
  status: 'connected',
  userId,
  membership,
  canSubmit: true,
});

function service() {
  return createCalendarService({
    db: database.db,
    tournaments: {
      async calendarEvents(_leagueId, _range, mode) {
        reads.push(`calendarEvents:${mode}`);
        if (brokenRead) throw brokenRead;
        // What play-tools and the rows hold when the read starts; a local read has only planned rows and no listing.
        const list =
          mode === 'local'
            ? tournaments.filter((t) => t.plannedId !== null).map((t) => ({ ...t, listedBy: null, applicationState: null }))
            : tournaments;
        const read = mode === 'local' ? [] : [...new Set(list.flatMap((t) => (t.listedBy ? [t.listedBy] : [])))].filter((p) => !failed.some((f) => f.playerId === p));
        const answer = { tournaments: list, upstream: mode === 'local' ? ('local' as const) : ('read' as const), read, failed: mode === 'local' ? [] : failed, unmatched: false };
        if (gate) await gate;
        return answer;
      },
      async checkTournament(_leagueId, playerId, tournamentId) {
        reads.push(`checkTournament:${tournamentId}@${playerId}`);
        return checks[tournamentId] ?? { kind: 'unreadable' };
      },
    },
    sessions: {
      async listPlaySessionsInRange() {
        reads.push('listPlaySessionsInRange');
        if (sessions instanceof Error) throw sessions;
        return sessions;
      },
    },
    staffing: {
      liveAssignmentsFor: (_leagueId, playerIds) =>
        playerIds.includes('0022222') ? [{ tournamentId: 'g1', playerId: '0022222', role: 'judge', roleLabel: 'Judge', createdAt: new Date('2026-10-01T00:00:00Z') }] : [],
    },
    leases: { liveLeasesFor: (userId) => leases.get(userId) ?? [] },
    connections: {
      league: () => league,
      listActingConnections: () => connections,
      listReadableConnections: () => connections.filter((c) => c.membership !== 'outside'),
    },
    accounts: { actor: (userId) => actors.get(userId) ?? null },
    timeZone: TZ,
    now: () => now,
    randomBytes: (size) => Buffer.alloc(size, ++serial),
    refreshWaitMs: 200,
    log: {
      info: (message, fields) => void logs.push({ level: 'info', message, fields: fields ?? {} }),
      warn: (message, fields) => void logs.push({ level: 'warn', message, fields: fields ?? {} }),
    },
  });
}

beforeEach(() => {
  database = openDatabase(':memory:');
  migrateDatabase(database.db, MIGRATIONS_DIR);
  database.sqlite.prepare(`insert into app_user (id, username, password_hash, role, created_at) values (1, 'organizer', 'x', 'owner', 0), (2, 'misty', 'x', 'professor', 0)`).run();
  now = new Date('2026-10-20T15:00:00Z');
  serial = 0;
  logs = [];
  tournaments = [calendarTournament(), upstreamOnly('g2', MISTY)];
  failed = [];
  sessions = [playSession('s1', '2026-10-22T23:00:00Z', { status: 'active' })];
  checks = {};
  connections = [conn(1, 1, OAK), conn(2, 2, MISTY)];
  league = { id: 'group-1', name: 'Cerulean League', displayId: 'L1' };
  actors = new Map([
    [1, OWNER],
    [2, MISTY_USER],
  ]);
  reads = [];
  gate = null;
  leases = new Map();
  brokenRead = null;
  calendar = service();
});
afterEach(() => database.close());

/** The UIDs in a feed, its folded lines joined first (RFC 5545). */
const uidsIn = (body: string) => [...body.replace(/\r\n /g, '').matchAll(/^UID:(.+)\r$/gm)].map((m) => m[1]).sort();

async function served(secret: string) {
  const answer = await calendar.serve(secret);
  if (answer.kind !== 'ok') throw new Error(`refused: ${JSON.stringify(answer)}`);
  return answer;
}

describe('turning a feed on', () => {
  it('refreshes before answering when there is no snapshot, so the first fetch has events', async () => {
    const { secret, created } = await calendar.mint(L, OWNER, 'public');

    expect(created).toBe(true);
    expect(reads).toEqual(['calendarEvents:refresh', 'listPlaySessionsInRange']);
    expect(uidsIn((await served(secret)).body)).toEqual([
      'planned-1@default.play-pokemon-attendance',
      'session-s1@default.play-pokemon-attendance',
      'tournament-g2@default.play-pokemon-attendance',
    ]);
  });

  it('reuses a snapshot refreshed under 5 minutes ago, and refreshes an older one', async () => {
    await calendar.mint(L, OWNER, 'public');
    reads = [];

    now = new Date(now.getTime() + 2 * MINUTE);
    await calendar.mint(L, OWNER, 'public');
    expect(reads).toEqual([]);

    now = new Date(now.getTime() + 4 * MINUTE);
    await calendar.mint(L, MISTY_USER, 'user');
    expect(reads).toEqual(['calendarEvents:refresh', 'listPlaySessionsInRange']);
  });

  it('keeps the old link working until play-tools answers, and answers with the new link once the wait is over', async () => {
    const old = (await calendar.mint(L, OWNER, 'public')).secret;
    now = new Date(now.getTime() + 10 * MINUTE);
    gate = new Promise(() => undefined); // play-tools never answers

    const rotating = calendar.mint(L, OWNER, 'public');
    // The refresh is waiting on play-tools, and the old link still works.
    await vi.waitFor(() => expect(reads.at(-1)).toBe('calendarEvents:refresh'), { interval: 1 });
    expect(await calendar.serve(old)).toMatchObject({ kind: 'ok' });

    const { secret } = await rotating;
    expect(await calendar.serve(old)).toMatchObject({ kind: 'refused', reason: 'permanent' });
    expect((await calendar.serve(secret)).kind).toBe('ok');
  });

  it('still answers with the link when the refresh fails, and serves no events', async () => {
    tournaments = [];
    sessions = new PokemonUpstreamError('unavailable', 'play-tools is down');

    const { secret } = await calendar.mint(L, OWNER, 'public');

    expect(uidsIn((await served(secret)).body)).toEqual([]);
  });

  it("lets the owner's and a professor's feeds be shown, each only to their holder, with the snapshot's age", async () => {
    await calendar.mint(L, OWNER, 'public');
    await calendar.mint(L, MISTY_USER, 'user');

    expect(calendar.feeds(L, OWNER)).toEqual({
      me: null,
      public: expect.objectContaining({ hint: expect.stringMatching(/^ppa_cal_…/) }),
      snapshot: { builtAt: now.toISOString(), staleSources: [] },
    });
    const mistys = calendar.feeds(L, MISTY_USER);
    expect(mistys.me).toEqual(expect.objectContaining({ hint: expect.stringMatching(/^ppa_cal_…/) }));
    expect(mistys).not.toHaveProperty('public');
  });
});

describe('what a fetch answers', () => {
  it('serves the public feed with a stable ETag, records the read once a minute, and calls nobody', async () => {
    const { secret } = await calendar.mint(L, OWNER, 'public');
    reads = [];

    const first = await served(secret);
    const second = await served(secret);

    expect(first.etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(second.etag).toBe(first.etag);
    expect(first.body).toContain('X-WR-CALNAME:Cerulean League');
    expect(reads).toEqual([]);
    expect(calendar.feeds(L, OWNER).public!.lastReadAt).toBe(now.toISOString());
    expect(logs.filter((l) => l.message === 'calendar feed read')).toEqual([
      { level: 'info', message: 'calendar feed read', fields: { feedId: first.feedId, kind: 'public', events: 3, snapshotAgeSeconds: 0 } },
      expect.anything(),
    ]);
    expect(JSON.stringify(logs)).not.toContain(secret);
  });

  it("serves a professor's feed with only their tournaments", async () => {
    const { secret } = await calendar.mint(L, MISTY_USER, 'user');

    const { body } = await served(secret);

    expect(body).toContain('X-WR-CALNAME:Cerulean League: my tournaments');
    expect(uidsIn(body)).toEqual(['tournament-g2@default.play-pokemon-attendance']);
  });

  it.each([
    ['nothing', null],
    ['a malformed secret', 'ppa_cal_short'],
    ['an unknown secret', `ppa_cal_${'A'.repeat(43)}`],
  ])('refuses %s for good, without a match', async (_, secret) => {
    expect(await calendar.serve(secret)).toEqual({ kind: 'refused', reason: 'permanent', matched: false });
  });

  it('refuses a rotated or turned-off secret for good', async () => {
    const old = (await calendar.mint(L, OWNER, 'public')).secret;
    await calendar.mint(L, OWNER, 'public');
    expect(await calendar.serve(old)).toEqual({ kind: 'refused', reason: 'permanent', matched: false });

    const mistys = (await calendar.mint(L, MISTY_USER, 'user')).secret;
    calendar.turnOff(L, MISTY_USER, 'user');
    expect(await calendar.serve(mistys)).toEqual({ kind: 'refused', reason: 'permanent', matched: false });
  });

  it("refuses for good a removed professor's feed and one whose connections are all outside the league", async () => {
    const { secret } = await calendar.mint(L, MISTY_USER, 'user');

    connections = [conn(1, 1, OAK), conn(2, 2, MISTY, 'outside')];
    expect(await calendar.serve(secret)).toEqual({ kind: 'refused', reason: 'permanent', matched: true });

    actors.delete(2);
    expect(await calendar.serve(secret)).toEqual({ kind: 'refused', reason: 'permanent', matched: true });
  });

  it('refuses for now while a membership is unknown, a re-verify is pending, no league is chosen, or there is no snapshot', async () => {
    const { secret } = await calendar.mint(L, MISTY_USER, 'user');

    connections = [conn(1, 1, OAK), conn(2, 2, MISTY, 'unknown')];
    expect(await calendar.serve(secret)).toEqual({ kind: 'refused', reason: 'temporary', matched: true });

    connections = [conn(1, 1, OAK), conn(2, 2, MISTY)];
    actors.set(2, { ...MISTY_USER, reverifyRequired: true });
    expect(await calendar.serve(secret)).toEqual({ kind: 'refused', reason: 'temporary', matched: true });

    actors.set(2, MISTY_USER);
    league = null;
    expect(await calendar.serve(secret)).toEqual({ kind: 'refused', reason: 'temporary', matched: true });

    league = { id: 'group-1', name: 'Cerulean League', displayId: 'L1' };
    database.sqlite.prepare('delete from calendar_snapshot').run();
    expect(await calendar.serve(secret)).toEqual({ kind: 'refused', reason: 'temporary', matched: true });
  });

  it('serves a member professor with one connection outside and one member', async () => {
    const { secret } = await calendar.mint(L, MISTY_USER, 'user');
    connections = [conn(1, 1, OAK), conn(2, 2, MISTY), conn(3, 2, '0033333', 'outside')];

    expect((await calendar.serve(secret)).kind).toBe('ok');
  });

  it('serves a professor who disconnected an empty calendar, even with a tournament still lent to them', async () => {
    const { secret } = await calendar.mint(L, MISTY_USER, 'user');
    leases.set(MISTY_USER.userId, [{ tournamentId: 'g1', endsAt: new Date('2026-11-15T06:00:00Z'), grantedAt: now }]);
    expect(uidsIn((await served(secret)).body)).toContain('planned-1@default.play-pokemon-attendance');

    connections = [conn(1, 1, OAK)];

    expect(uidsIn((await served(secret)).body)).toEqual([]);
  });

  it('marks a removed professor\'s tournaments not confirmed in the public feed at once', async () => {
    const { secret } = await calendar.mint(L, OWNER, 'public');
    connections = [conn(1, 1, OAK)];

    expect((await served(secret)).body).toContain('SUMMARY:Cup g2 (not confirmed since 2026-10-20)');
  });
});

describe('the refresh queue', () => {
  it('runs one refresh at a time per league: later requests reuse it, and a local rebuild runs once after it', async () => {
    await calendar.mint(L, OWNER, 'public');
    reads = [];
    let open!: () => void;
    gate = new Promise((resolve) => (open = resolve));

    const first = calendar.refresh(L);
    // The first refresh is running, held at the gate, before anything else is asked for.
    await vi.waitFor(() => expect(reads).toEqual(['calendarEvents:refresh']));
    const second = calendar.refresh(L);
    const rebuild1 = calendar.rebuildLocal(L);
    const rebuild2 = calendar.rebuildLocal(L);
    open();
    await Promise.all([first, second, rebuild1, rebuild2]);

    expect(reads).toEqual(['calendarEvents:refresh', 'listPlaySessionsInRange', 'calendarEvents:local']);
  });

  it('says how a refresh went: ok with the sources it could not read, or failed when nothing was written', async () => {
    await calendar.mint(L, OWNER, 'public');

    failed = [{ playerId: MISTY, code: 'needs_reconnect' }];
    expect(await calendar.refresh(L)).toEqual({ ok: true, failedSources: 1 });

    failed = [];
    sessions = new PokemonUpstreamError('unavailable', 'down');
    expect(await calendar.refresh(L)).toEqual({ ok: true, failedSources: 1 });

    brokenRead = new Error('database is locked');
    expect(await calendar.refresh(L)).toEqual({ ok: false, failedSources: 0 });
  });

  it('keeps every writer’s change: a rebuild queued behind a refresh sees what the refresh wrote', async () => {
    await calendar.mint(L, OWNER, 'public');
    reads = [];
    tournaments = [...tournaments, upstreamOnly('g3', OAK)];
    let open!: () => void;
    gate = new Promise((resolve) => (open = resolve));

    const refreshed = calendar.refresh(L);
    // The refresh has read g3 and waits at the gate; then play-tools loses it and a rebuild is asked for.
    await vi.waitFor(() => expect(reads).toContain('calendarEvents:refresh'));
    tournaments = tournaments.filter((t) => t.tournamentId !== 'g3');
    const rebuilt = calendar.rebuildLocal(L);
    open();
    await Promise.all([refreshed, rebuilt]);

    const pub = await calendar.mint(L, OWNER, 'public');
    expect(uidsIn((await served(pub.secret)).body)).toContain('tournament-g3@default.play-pokemon-attendance');
  });

  it('does nothing on a local rebuild before any refresh', async () => {
    await calendar.rebuildLocal(L);

    expect(reads).toEqual([]);
    expect(database.sqlite.prepare('select count(*) as n from calendar_snapshot').get()).toEqual({ n: 0 });
  });

  it('logs each source that failed, with its error code', async () => {
    failed = [{ playerId: MISTY, code: 'needs_reconnect' }];
    sessions = new PokemonUpstreamError('unavailable', 'play-tools is down');

    await calendar.mint(L, OWNER, 'public');

    expect(logs.filter((l) => l.level === 'warn').map((l) => l.fields)).toEqual([
      { source: `professor:${MISTY}`, code: 'needs_reconnect' },
      { source: 'sessions', code: 'unavailable' },
    ]);
  });

  it('makes one details read of a tournament that dropped out of its listing, and cancels it when it is off', async () => {
    const { secret } = await calendar.mint(L, OWNER, 'public');
    tournaments = [calendarTournament(), upstreamOnly('g9', MISTY)];
    checks = { g2: { kind: 'cancelled' } };
    reads = [];

    await calendar.refresh(L);

    expect(reads).toContain(`checkTournament:g2@${MISTY}`);
    expect((await served(secret)).body).toContain('SUMMARY:Cancelled: Cup g2');
  });
});

describe('matchFeed', () => {
  it("gives the feed a secret belongs to, for the route's limits, without counting it as a read", async () => {
    const { secret } = await calendar.mint(L, OWNER, 'public');

    expect(calendar.matchFeed(secret)).toEqual(expect.any(Number));
    expect(calendar.matchFeed(`ppa_cal_${'A'.repeat(43)}`)).toBeNull();
    expect(calendar.matchFeed(null)).toBeNull();
    expect(calendar.feeds(L, OWNER).public!.lastReadAt).toBeNull();
  });
});

describe('refreshDue', () => {
  it('lists a league only while one of its feeds was read, created or rotated in the last 48 hours', async () => {
    const { secret } = await calendar.mint(L, OWNER, 'public');
    await served(secret);

    now = new Date(now.getTime() + 47 * HOUR);
    expect(calendar.refreshDue()).toEqual([L]);

    now = new Date(now.getTime() + 2 * HOUR);
    expect(calendar.refreshDue()).toEqual([]);
  });
});

describe('deleteUserFeeds', () => {
  it("deletes a removed professor's feed", async () => {
    const { secret } = await calendar.mint(L, MISTY_USER, 'user');

    calendar.deleteUserFeeds(2);

    expect(await calendar.serve(secret)).toEqual({ kind: 'refused', reason: 'permanent', matched: false });
  });
});

describe('staffing in a user feed', () => {
  it("shows a professor the tournaments they are staff on, with the role", async () => {
    connections = [...connections, conn(4, 3, '0022222')];
    actors.set(3, professorActor(3, 'brock'));
    database.sqlite.prepare(`insert into app_user (id, username, password_hash, role, created_at) values (3, 'brock', 'x', 'professor', 0)`).run();
    const { secret } = await calendar.mint(L, professorActor(3, 'brock'), 'user');

    const { body } = await served(secret);

    expect(uidsIn(body)).toEqual(['planned-1@default.play-pokemon-attendance']);
    expect(body).toContain('DESCRIPTION:Staff: Judge\\nTCG');
  });
});
