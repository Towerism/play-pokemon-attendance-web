import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import { type FeedStore, createFeedStore } from './feeds';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));

let database: OpenDatabase;
let feeds: FeedStore;
let now: Date;
let serial: number;
let owner: number;
let misty: number;
/** 32 fixed bytes per call, different each call, so secrets are predictable but distinct. */
const random = (size: number) => Buffer.alloc(size, ++serial);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const rows = () => database.sqlite.prepare('select * from calendar_feed order by id').all() as Record<string, unknown>[];
const user = (username: string, role: string) =>
  database.sqlite.prepare(`insert into app_user (username, password_hash, role, created_at) values (?, 'x', ?, 1760000000)`).run(username, role)
    .lastInsertRowid as number;

beforeEach(() => {
  database = openDatabase(':memory:');
  migrateDatabase(database.db, MIGRATIONS_DIR);
  owner = user('organizer', 'owner');
  misty = user('misty', 'professor');
  now = new Date('2026-10-20T12:00:00Z');
  serial = 0;
  feeds = createFeedStore({ db: database.db, now: () => now, randomBytes: random });
});
afterEach(() => database.close());

describe('mint', () => {
  it('turns a feed on with a ppa_cal_ secret shown once, storing only its SHA-256 and a hint', () => {
    const { secret, feed, created } = feeds.mint(L, { kind: 'user', userId: misty });

    expect(secret).toMatch(/^ppa_cal_[A-Za-z0-9_-]{43}$/);
    expect(created).toBe(true);
    expect(feed).toEqual({ hint: `ppa_cal_…${secret.slice(-4)}`, createdAt: '2026-10-20T12:00:00.000Z', lastReadAt: null });
    expect(rows()).toEqual([
      expect.objectContaining({ kind: 'user', user_id: misty, token_sha256: sha256(secret), hint: feed.hint, last_read_at: null }),
    ]);
    expect(JSON.stringify(rows())).not.toContain(secret);
  });

  it('rotates an existing feed in place: a new secret, the old one stops matching, and the read time clears', () => {
    const first = feeds.mint(L, { kind: 'public' });
    feeds.markRead(feeds.find(first.secret)!.id);
    now = new Date('2026-10-21T08:00:00Z');

    const second = feeds.mint(L, { kind: 'public' });

    expect(second.created).toBe(false);
    expect(second.secret).not.toBe(first.secret);
    expect(feeds.find(first.secret)).toBeNull();
    expect(feeds.find(second.secret)).toMatchObject({ kind: 'public', leagueId: L, userId: null });
    expect(rows()).toHaveLength(1);
    expect(second.feed).toEqual({ hint: `ppa_cal_…${second.secret.slice(-4)}`, createdAt: '2026-10-21T08:00:00.000Z', lastReadAt: null });
  });

  it('keeps one feed per user and one public feed', () => {
    feeds.mint(L, { kind: 'user', userId: owner });
    feeds.mint(L, { kind: 'user', userId: misty });
    feeds.mint(L, { kind: 'public' });
    feeds.mint(L, { kind: 'user', userId: misty });

    expect(rows().map((r) => [r.kind, r.user_id])).toEqual([
      ['user', owner],
      ['user', misty],
      ['public', null],
    ]);
  });
});

describe('view', () => {
  it("answers a user's own feed, the public feed, or null when off", () => {
    expect(feeds.view(L, { kind: 'user', userId: misty })).toBeNull();
    const { feed } = feeds.mint(L, { kind: 'user', userId: misty });

    expect(feeds.view(L, { kind: 'user', userId: misty })).toEqual(feed);
    expect(feeds.view(L, { kind: 'user', userId: owner })).toBeNull();
    expect(feeds.view(L, { kind: 'public' })).toBeNull();
  });
});

describe('turnOff', () => {
  it('deletes the feed so its secret stops matching, and does nothing when it is already off', () => {
    const { secret } = feeds.mint(L, { kind: 'user', userId: misty });

    feeds.turnOff(L, { kind: 'user', userId: misty });
    feeds.turnOff(L, { kind: 'user', userId: misty });
    feeds.turnOff(L, { kind: 'public' });

    expect(feeds.find(secret)).toBeNull();
    expect(rows()).toEqual([]);
  });
});

describe('deleteUserFeeds', () => {
  it("deletes a removed user's feed and leaves everyone else's", () => {
    const mistys = feeds.mint(L, { kind: 'user', userId: misty });
    const owners = feeds.mint(L, { kind: 'user', userId: owner });
    const pub = feeds.mint(L, { kind: 'public' });

    feeds.deleteUserFeeds(misty);

    expect(feeds.find(mistys.secret)).toBeNull();
    expect(feeds.find(owners.secret)).not.toBeNull();
    expect(feeds.find(pub.secret)).not.toBeNull();
  });
});

describe('find', () => {
  it('matches a live secret by its digest', () => {
    const { secret } = feeds.mint(L, { kind: 'user', userId: misty });

    expect(feeds.find(secret)).toEqual({ id: expect.any(Number), leagueId: L, kind: 'user', userId: misty, lastReadAt: null });
  });

  it.each([
    ['nothing', null],
    ['an empty string', ''],
    ['another prefix', `ppa_int_${'A'.repeat(43)}`],
    ['a short secret', `ppa_cal_${'A'.repeat(42)}`],
    ['a long secret', `ppa_cal_${'A'.repeat(44)}`],
    ['characters outside base64url', `ppa_cal_${'A'.repeat(42)}+`],
    ['surrounding whitespace', ` ppa_cal_${'A'.repeat(43)}`],
    ['a 2 KB value', 'ppa_cal_' + 'A'.repeat(2048)],
  ])('refuses %s without a match', (_, value) => {
    expect(feeds.find(value)).toBeNull();
  });

  it('refuses a well-formed secret that matches no feed', () => {
    expect(feeds.find(`ppa_cal_${'A'.repeat(43)}`)).toBeNull();
  });
});

describe('markRead', () => {
  it('records a read at most once a minute', () => {
    const { secret } = feeds.mint(L, { kind: 'public' });
    const id = feeds.find(secret)!.id;

    feeds.markRead(id);
    const first = feeds.view(L, { kind: 'public' })!.lastReadAt;
    now = new Date(now.getTime() + 59_000);
    feeds.markRead(id);
    expect(feeds.view(L, { kind: 'public' })!.lastReadAt).toBe(first);

    now = new Date(now.getTime() + 2_000);
    feeds.markRead(id);
    expect(feeds.view(L, { kind: 'public' })!.lastReadAt).toBe('2026-10-20T12:01:01.000Z');
  });
});

describe('leaguesInUse', () => {
  it('lists a league whose feed was read, created or rotated since the given time', () => {
    const since = new Date('2026-10-18T12:00:00Z');
    expect(feeds.leaguesInUse(since)).toEqual([]);

    now = new Date('2026-10-10T12:00:00Z');
    const { secret } = feeds.mint(L, { kind: 'public' });
    expect(feeds.leaguesInUse(since)).toEqual([]);

    now = new Date('2026-10-18T13:00:00Z');
    feeds.markRead(feeds.find(secret)!.id);
    expect(feeds.leaguesInUse(since)).toEqual([L]);
  });

  it('counts a feed created inside the window even before its first read', () => {
    feeds.mint(L, { kind: 'user', userId: misty });

    expect(feeds.leaguesInUse(new Date('2026-10-18T12:00:00Z'))).toEqual([L]);
  });
});
