import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { messageVault, tokenVault } from '../../bootstrap/vaults';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import type { Actor } from '../accounts/service';
import { type MessagingService, createMessagingService } from '../messaging/channel';
import { type PokemonConnectionService, createPokemonConnectionService } from './connection';
import { type LeaseService, LeaseError, createLeaseService, createLeaseStore } from './leases';
import { PokemonUpstreamError } from './ports/errors';
import type { PtcOAuthClient } from './ports/ptc-oauth';
import type { TournamentDetails } from './ports/play-tools-gateway';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const ZONE = 'America/Chicago';
const NOW = new Date('2026-11-01T17:00:00Z');
const GROUP = 'group-1';
const DAY = 86_400_000;

const actor = (userId: number, username: string, role: Actor['role']): Actor => ({ userId, username, role, reverifyRequired: false });
const OWNER = actor(1, 'organizer', 'owner');
const MISTY = actor(2, 'misty', 'professor');
const BROCK = actor(3, 'brock', 'professor');
const GARY = actor(4, 'gary', 'professor');
const GONE = actor(5, 'surge', 'professor');

/** Connection ids, by whose they are. */
const OAK = 1; // the owner's, 0099999 "Prof Oak"
const OAK_TWO = 2; // the owner's second, 0088888, not in the league
const MISTY_CONN = 3; // 0011111
const BROCK_CONN = 4; // 0022222
const GARY_CONN = 5; // 0033333, outside

let database: OpenDatabase;
let clock: Date;
let connections: PokemonConnectionService;
let messaging: MessagingService;
let leases: LeaseService;
let tournaments: Map<string, TournamentDetails>;
let reads: { connectionId: number; tournamentId: string }[];
let readError: Error | undefined;
let siteUrl: string | null;
let info: ReturnType<typeof vi.fn>;

const sql = (q: string, ...params: unknown[]) => database.sqlite.prepare(q).run(...params);
const all = (q: string, ...params: unknown[]) => database.sqlite.prepare(q).all(...params) as Record<string, unknown>[];
const playerOf: Record<number, string> = { [OAK]: '0099999', [OAK_TWO]: '0088888', [MISTY_CONN]: '0011111', [BROCK_CONN]: '0022222', [GARY_CONN]: '0033333' };

function tournament(id: string, overrides: Partial<Omit<TournamentDetails, 'organizerPlayerId'>> & { organizerPlayerId?: string } = {}): TournamentDetails {
  return {
    id,
    name: 'League Cup',
    displayId: '26-11-000001',
    groupId: GROUP,
    products: ['tcg'],
    startsAt: new Date('2026-11-07T16:00:00Z'), // 10:00 in Chicago, after DST ends
    status: 'sanctioned',
    applicationState: 'sanctioned',
    editableUntil: null,
    organizerPlayerId: '0099999' as TournamentDetails['organizerPlayerId'],
    organizerName: 'Samuel Oak',
    activityState: 'pending',
    category: 'tcg_std',
    series: null,
    venue: null,
    contact: { name: null, email: null, phone: null } as unknown as TournamentDetails['contact'],
    registration: null,
    onSiteAdmission: null,
    thirdPartyRegistrationUrl: null,
    details: null,
    eventWebsite: null,
    ...overrides,
  } as TournamentDetails;
}

function seed() {
  for (const a of [OWNER, MISTY, BROCK, GARY, GONE]) {
    sql(`insert into app_user (id, username, password_hash, role, created_at) values (?, ?, 'hash', ?, 1760000000)`, a.userId, a.username, a.role);
  }
  sql(`update app_user set removed_at = 1761000000 where id = ?`, GONE.userId);
  const conn = (id: number, userId: number, name: string | null, membership: string) => {
    sql(
      `insert into pokemon_connection (id, user_id, ptc_user_id, professor_player_id, professor_name, refresh_token_ciphertext, status, connected_at, last_refreshed_at)
       values (?, ?, ?, ?, ?, x'00', 'connected', 1760000000, 1760000000)`,
      id,
      userId,
      `ptc-${id}`,
      playerOf[id],
      name,
    );
    sql(`insert into league_membership (connection_id, league_id, status, can_submit) values (?, ?, ?, 1)`, id, L, membership);
  };
  conn(OAK, OWNER.userId, 'Prof Oak', 'member');
  conn(OAK_TWO, OWNER.userId, null, 'outside');
  conn(MISTY_CONN, MISTY.userId, 'Misty', 'member');
  conn(BROCK_CONN, BROCK.userId, 'Brock', 'member');
  conn(GARY_CONN, GARY.userId, 'Gary', 'outside');
  sql(`insert into league_upstream (league_id, activity_group_id, activity_group_name) values (?, ?, 'Card Shop')`, L, GROUP);
}

const accounts = {
  actor: (id: number) => [OWNER, MISTY, BROCK, GARY].find((a) => a.userId === id) ?? null,
  activeActors: () => [OWNER, MISTY, BROCK, GARY],
};

function build() {
  connections = createPokemonConnectionService({
    db: database.db,
    vault: tokenVault(Buffer.alloc(32, 3).toString('base64')),
    oauth: {} as PtcOAuthClient,
    gateway: () => ({}) as never,
    accounts: { ...accounts, clearReverify: () => {}, seatsUsed: () => 0, boundPlayerId: () => null },
    now: () => clock,
  });
  leases = createLeaseService({
    db: database.db,
    store: createLeaseStore({ db: database.db, now: () => clock }),
    connections,
    accounts,
    gateway: (connectionId) => ({
      async getTournament(tournamentId: string) {
        reads.push({ connectionId, tournamentId });
        if (readError) throw readError;
        const t = tournaments.get(tournamentId);
        if (!t || t.organizerPlayerId !== playerOf[connectionId]) throw new PokemonUpstreamError('not_found', 'no such tournament');
        return t;
      },
    }),
    channel: messaging,
    timeZone: ZONE,
    siteUrl: () => siteUrl,
    now: () => clock,
    log: { info, warn: vi.fn() },
  });
}

async function genieConnects() {
  await messaging.poll(L, 1, { waitMs: 0, limit: 50 });
}

const messages = () => all('select player_id, text, topic, ref, link_label, status from outbound_message order by id');
const leaseRows = () => all('select id, tournament_id, connection_id, lessee_user_id, ends_at, ended_at, end_reason, notice_delivery from tournament_lease order by id');

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  clock = NOW;
  vi.setSystemTime(NOW);
  database = openDatabase(':memory:');
  migrateDatabase(database.db, MIGRATIONS_DIR);
  seed();
  tournaments = new Map(
    [
      tournament('t1', { name: 'League Cup' }),
      tournament('t3', { name: 'League Challenge', startsAt: new Date('2026-11-14T22:00:00Z') }),
      tournament('t2', { name: 'Prerelease', organizerPlayerId: '0011111' }),
      tournament('t-brock', { organizerPlayerId: '0022222' }),
      tournament('t-other-group', { groupId: 'group-2' }),
      tournament('t-cancelled', { status: 'cancelled', applicationState: 'cancelled' }),
      tournament('t-no-start', { startsAt: null }),
      tournament('t-old', { startsAt: new Date('2026-09-01T16:00:00Z') }),
    ].map((t) => [t.id, t]),
  );
  reads = [];
  readError = undefined;
  siteUrl = 'https://league.example';
  info = vi.fn();
  messaging = createMessagingService({ db: database.db, vault: messageVault(Buffer.alloc(32, 7).toString('base64')), leagueId: L });
  build();
  await genieConnects();
});
afterEach(() => {
  messaging.drain();
  database.close();
  vi.useRealTimers();
});

async function refusal(promise: Promise<unknown>) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(LeaseError);
  return err as LeaseError;
}

describe('granting', () => {
  it('lends a tournament until the end of the 7th day after its start, in the league time zone, and queues one notice', async () => {
    const { leases: granted } = await leases.grant(L, OWNER, { tournamentIds: ['t1'], lesseeUserId: MISTY.userId });

    expect(granted).toHaveLength(1);
    expect(granted[0]).toMatchObject({
      tournamentId: 't1',
      label: 'League Cup · 2026-11-07',
      organizer: { playerId: '0099999', name: 'Prof Oak' },
      lessee: { userId: MISTY.userId, username: 'misty', name: 'Misty' },
      grantedBy: 'organizer',
      endsAt: '2026-11-15T06:00:00.000Z', // local midnight starting Nov 15 (CST)
      notice: 'sending',
      mine: 'organizer',
    });
    expect(messages()).toEqual([
      expect.objectContaining({ player_id: '0011111', topic: 'lease', ref: `grant:${granted[0]!.id}`, status: 'pending', link_label: 'Open Play! Pokémon Attendance' }),
    ]);
  });

  it('lends several tournaments in one step with one notice naming them all', async () => {
    const { leases: granted } = await leases.grant(L, OWNER, { tournamentIds: ['t1', 't3'], lesseeUserId: MISTY.userId });

    expect(granted.map((l) => l.tournamentId)).toEqual(['t1', 't3']);
    const [m] = messages();
    expect(messages()).toHaveLength(1);
    expect(m!.ref).toBe(`grant:${granted[0]!.id},${granted[1]!.id}`);
    expect(m!.text).toContain('League Cup · 2026-11-07');
    expect(m!.text).toContain('League Challenge · 2026-11-14');
    expect(m!.text).toContain('them');
  });

  it('takes an explicit end within 30 days of the start', async () => {
    const endsAt = new Date('2026-12-07T16:00:00Z').toISOString();
    const { leases: granted } = await leases.grant(L, OWNER, { tournamentIds: ['t1'], lesseeUserId: MISTY.userId, endsAt });
    expect(granted[0]!.endsAt).toBe(endsAt);
  });

  it('refuses all of a grant when one tournament is already lent, writing nothing', async () => {
    await leases.grant(L, OWNER, { tournamentIds: ['t1'], lesseeUserId: MISTY.userId });

    const err = await refusal(leases.grant(L, OWNER, { tournamentIds: ['t1', 't3'], lesseeUserId: BROCK.userId }));
    expect(err.code).toBe('lease_refused');
    expect(err.data?.refusals).toEqual([{ tournamentId: 't1', code: 'already_leased', message: expect.any(String) }]);
    expect(leaseRows().map((r) => r.tournament_id)).toEqual(['t1']);
  });

  it("refuses a tournament the caller doesn't organize, reading only as the caller's connections", async () => {
    const err = await refusal(leases.grant(L, MISTY, { tournamentIds: ['t1', 'unknown-guid'], lesseeUserId: BROCK.userId }));

    expect(err.data?.refusals).toEqual([
      { tournamentId: 't1', code: 'not_your_tournament', message: expect.any(String) },
      { tournamentId: 'unknown-guid', code: 'not_your_tournament', message: expect.any(String) },
    ]);
    expect(new Set(reads.map((r) => r.connectionId))).toEqual(new Set([MISTY_CONN]));
  });

  it.each([
    ['t-other-group', 'unknown_tournament'],
    ['t-cancelled', 'tournament_cancelled'],
    ['t-no-start', 'no_start_date'],
    ['t-old', 'lease_window_passed'],
  ])('refuses %s as %s', async (id, code) => {
    const err = await refusal(leases.grant(L, OWNER, { tournamentIds: [id], lesseeUserId: MISTY.userId }));
    expect(err.data?.refusals).toEqual([{ tournamentId: id, code, message: expect.any(String) }]);
  });

  it('refuses an end more than 30 days after the start', async () => {
    const endsAt = new Date('2026-12-07T16:00:01Z').toISOString();
    const err = await refusal(leases.grant(L, OWNER, { tournamentIds: ['t1'], lesseeUserId: MISTY.userId, endsAt }));
    expect(err.data?.refusals).toEqual([{ tournamentId: 't1', code: 'ends_at_too_late', message: expect.any(String) }]);
  });

  it('refuses an end that has already passed', async () => {
    const err = await refusal(leases.grant(L, OWNER, { tournamentIds: ['t1'], lesseeUserId: MISTY.userId, endsAt: new Date(NOW.getTime() - 1).toISOString() }));
    expect(err.code).toBe('ends_at_invalid');
  });

  it('refuses lending to yourself before reading anything', async () => {
    const err = await refusal(leases.grant(L, OWNER, { tournamentIds: ['t1'], lesseeUserId: OWNER.userId }));
    expect(err.code).toBe('lessee_is_you');
    expect(reads).toEqual([]);
  });

  it.each([
    ['an outside professor', GARY.userId],
    ['a removed professor', GONE.userId],
    ['an unknown user', 999],
  ])('refuses lending to %s with one message', async (_who, userId) => {
    const err = await refusal(leases.grant(L, OWNER, { tournamentIds: ['t1'], lesseeUserId: userId }));
    expect(err.code).toBe('lessee_not_member');
    expect(err.message).toBe("That person isn't a member of the league, so nothing can be lent to them.");
  });

  it('refuses lending to a professor who must confirm their Pokémon login after a reset', async () => {
    accounts.actor = (id) => (id === MISTY.userId ? { ...MISTY, reverifyRequired: true } : [OWNER, BROCK, GARY].find((a) => a.userId === id) ?? null);
    try {
      const err = await refusal(leases.grant(L, OWNER, { tournamentIds: ['t1'], lesseeUserId: MISTY.userId }));
      expect(err.code).toBe('lessee_not_member');
    } finally {
      accounts.actor = (id) => [OWNER, MISTY, BROCK, GARY].find((a) => a.userId === id) ?? null;
    }
  });

  it('records a lease whose end has passed as expired before lending the tournament again', async () => {
    await leases.grant(L, OWNER, { tournamentIds: ['t1'], lesseeUserId: MISTY.userId, endsAt: new Date(NOW.getTime() + DAY).toISOString() });
    clock = new Date(NOW.getTime() + 2 * DAY);

    await leases.grant(L, OWNER, { tournamentIds: ['t1'], lesseeUserId: BROCK.userId });
    expect(leaseRows().map((r) => [r.lessee_user_id, r.end_reason])).toEqual([
      [MISTY.userId, 'expired'],
      [BROCK.userId, null],
    ]);
  });

  it('lets only one of two racing grants of a tournament through', async () => {
    const first = leases.grant(L, OWNER, { tournamentIds: ['t1'], lesseeUserId: MISTY.userId });
    const second = leases.grant(L, OWNER, { tournamentIds: ['t1'], lesseeUserId: BROCK.userId });
    const results = await Promise.allSettled([first, second]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ code: 'lease_refused', data: { refusals: [expect.objectContaining({ code: 'already_leased' })] } });
    expect(leaseRows()).toHaveLength(1);
  });

  it('still grants when Genie is away, saying no notice went out', async () => {
    vi.advanceTimersByTime(121_000);
    clock = new Date(clock.getTime() + 121_000);
    const { leases: granted } = await leases.grant(L, OWNER, { tournamentIds: ['t1'], lesseeUserId: MISTY.userId });
    expect(granted[0]!.notice).toBe('genie_unavailable');
    expect(messages()).toEqual([]);
  });

  it("sends the owner's notice to their lowest-numbered connection in the league", async () => {
    sql(`update league_membership set status = 'member' where connection_id = ?`, OAK_TWO);
    tournaments.set('t2', tournament('t2', { name: 'Prerelease', organizerPlayerId: '0011111' }));
    await leases.grant(L, MISTY, { tournamentIds: ['t2'], lesseeUserId: OWNER.userId });
    expect(messages()[0]!.player_id).toBe('0099999');

    sql(`update league_membership set status = 'outside' where connection_id = ?`, OAK);
    await leases.grant(L, OWNER, { tournamentIds: ['t3'], lesseeUserId: BROCK.userId }); // unrelated; keeps ids moving
    tournaments.set('t2b', tournament('t2b', { organizerPlayerId: '0011111' }));
    await leases.grant(L, MISTY, { tournamentIds: ['t2b'], lesseeUserId: OWNER.userId });
    expect(messages().at(-1)!.player_id).toBe('0088888');
  });

  it('strips Discord mentions from names and labels, and leaves the link out without a site URL', async () => {
    sql(`update pokemon_connection set professor_name = '<@123> Oak' where id = ?`, OAK);
    tournaments.set('t1', tournament('t1', { name: '@everyone Cup' }));
    siteUrl = null;
    await leases.grant(L, OWNER, { tournamentIds: ['t1'], lesseeUserId: MISTY.userId });

    const [m] = messages();
    expect(m!.text).not.toMatch(/<@|@/);
    expect(m!.text).toBe('organizer lent you everyone Cup · 2026-11-07 on Play! Pokémon Attendance until Sat, Nov 14. You can staff it and upload its results there.');
    expect(m!.link_label).toBeNull();
  });

  it('keeps a grant notice for many long-named tournaments within the channel limit, naming how many it left out', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `long-${i}`);
    for (const id of ids) tournaments.set(id, tournament(id, { name: `${'Very Long Regional League Challenge Name '.repeat(3)}${id}` }));
    const { leases: granted } = await leases.grant(L, OWNER, { tournamentIds: ids, lesseeUserId: MISTY.userId });

    expect(granted).toHaveLength(20);
    const [m] = messages();
    expect((m!.text as string).length).toBeLessThanOrEqual(1800);
    expect(m!.text).toMatch(/and \d+ more/);
  });

  it('logs the grant without the notice text', async () => {
    const { leases: granted } = await leases.grant(L, OWNER, { tournamentIds: ['t1'], lesseeUserId: MISTY.userId });
    expect(info).toHaveBeenCalledWith('tournament lease granted', {
      leaseId: granted[0]!.id,
      tournamentId: 't1',
      organizerPlayerId: '0099999',
      lessee: 'misty',
      endsAt: '2026-11-15T06:00:00.000Z',
      by: 'organizer',
    });
  });

  it('refuses a grant when no league is chosen', async () => {
    sql('delete from league_upstream');
    const err = await refusal(leases.grant(L, OWNER, { tournamentIds: ['t1'], lesseeUserId: MISTY.userId }));
    expect(err.code).toBe('league_not_selected');
  });

  it('writes nothing when play-tools fails during the reads', async () => {
    readError = new PokemonUpstreamError('unavailable', 'play-tools is down');
    await expect(leases.grant(L, OWNER, { tournamentIds: ['t1'], lesseeUserId: MISTY.userId })).rejects.toThrow(PokemonUpstreamError);
    expect(leaseRows()).toEqual([]);
  });
});

describe('listing', () => {
  it('lists the leases a user granted or holds, every lease for the owner, and who can be named', async () => {
    await leases.grant(L, OWNER, { tournamentIds: ['t1'], lesseeUserId: MISTY.userId });
    await leases.grant(L, MISTY, { tournamentIds: ['t2'], lesseeUserId: BROCK.userId });

    expect(leases.list(L, OWNER).leases.map((l) => l.tournamentId)).toEqual(['t1', 't2']);
    expect(leases.list(L, MISTY).leases.map((l) => [l.tournamentId, l.mine])).toEqual([
      ['t1', 'lessee'],
      ['t2', 'organizer'],
    ]);
    expect(leases.list(L, BROCK).leases.map((l) => l.tournamentId)).toEqual(['t2']);
    expect(leases.list(L, OWNER).lessees).toEqual([
      { userId: MISTY.userId, username: 'misty', name: 'Misty' },
      { userId: BROCK.userId, username: 'brock', name: 'Brock' },
    ]);
    expect(leases.list(L, MISTY).lessees.map((l) => l.username)).toEqual(['organizer', 'brock']);
  });

  it('gives each live lease for card views, from local rows only', async () => {
    await leases.grant(L, OWNER, { tournamentIds: ['t1'], lesseeUserId: MISTY.userId });
    reads = [];
    expect([...leases.leasesFor(['t1', 't3']).entries()]).toEqual([
      ['t1', { id: expect.any(Number), lesseeUserId: MISTY.userId, lesseeName: 'Misty', organizerName: 'Prof Oak', endsAt: '2026-11-15T06:00:00.000Z' }],
    ]);
    expect(reads).toEqual([]);
  });
});

describe('ending', () => {
  it('lets the organizer end a lease, with a notice saying who ended it', async () => {
    const { leases: granted } = await leases.grant(L, OWNER, { tournamentIds: ['t1'], lesseeUserId: MISTY.userId });
    const ended = leases.end(L, OWNER, granted[0]!.id);

    expect(ended.lease).toMatchObject({ endReason: 'ended', endedAt: NOW.toISOString() });
    expect(ended.endNotice).toBe('sending');
    expect(messages().at(-1)).toMatchObject({ player_id: '0011111', ref: `end:${granted[0]!.id}` });
    expect(messages().at(-1)!.text).toBe('Your lease on League Cup · 2026-11-07 has ended: Prof Oak ended it.');
    expect(leases.list(L, MISTY).leases).toEqual([]);
  });

  it('lets the lent professor give it back, sending nothing', async () => {
    const { leases: granted } = await leases.grant(L, OWNER, { tournamentIds: ['t1'], lesseeUserId: MISTY.userId });
    expect(leases.end(L, MISTY, granted[0]!.id)).toMatchObject({ lease: { endReason: 'given_back' }, endNotice: 'none' });
    expect(messages()).toHaveLength(1);
  });

  it("answers anyone else as if the lease didn't exist, and an ended lease unchanged", async () => {
    const { leases: granted } = await leases.grant(L, OWNER, { tournamentIds: ['t1'], lesseeUserId: MISTY.userId });
    expect(() => leases.end(L, BROCK, granted[0]!.id)).toThrow(expect.objectContaining({ code: 'lease_not_found' }));
    expect(() => leases.end(L, OWNER, 999)).toThrow(expect.objectContaining({ code: 'lease_not_found' }));

    leases.end(L, OWNER, granted[0]!.id);
    expect(leases.end(L, OWNER, granted[0]!.id)).toMatchObject({ lease: { endReason: 'ended' }, endNotice: 'none' });
    expect(messages()).toHaveLength(2);
  });

  it("doesn't let the owner end a lease another professor granted", async () => {
    const { leases: granted } = await leases.grant(L, MISTY, { tournamentIds: ['t2'], lesseeUserId: BROCK.userId });
    expect(() => leases.end(L, OWNER, granted[0]!.id)).toThrow(expect.objectContaining({ code: 'lease_not_found' }));
  });

  it('ends a cancelled tournament’s lease with a notice', async () => {
    await leases.grant(L, OWNER, { tournamentIds: ['t1'], lesseeUserId: MISTY.userId });
    leases.endLeasesForTournament('t1', 'tournament_cancelled');
    expect(leaseRows()[0]).toMatchObject({ end_reason: 'tournament_cancelled' });
    expect(messages().at(-1)!.text).toBe('Your lease on League Cup · 2026-11-07 has ended: the tournament was cancelled.');
  });
});

describe('expiring', () => {
  it('stops counting a lease the moment its end passes, and records it on the hourly run', async () => {
    const { leases: granted } = await leases.grant(L, OWNER, { tournamentIds: ['t1'], lesseeUserId: MISTY.userId });
    const store = createLeaseStore({ db: database.db, now: () => clock });
    expect(store.isLive(granted[0]!.id)).toBe(true);

    clock = new Date('2026-11-15T06:01:00Z');
    expect(store.isLive(granted[0]!.id)).toBe(false);
    expect(leases.expire()).toBe(1);
    expect(leaseRows()[0]).toMatchObject({ end_reason: 'expired', ended_at: new Date('2026-11-15T06:00:00Z').getTime() / 1000 });
    expect(messages().at(-1)!.text).toBe('Your lease on League Cup · 2026-11-07 has ended: it reached its end date.');
    expect(leases.expire()).toBe(0);
  });
});

describe('notice results', () => {
  it('shows the grant notice result on every lease it named, and ignores end notices', async () => {
    const { leases: granted } = await leases.grant(L, OWNER, { tournamentIds: ['t1', 't3'], lesseeUserId: MISTY.userId });
    const [grantMessage] = await messaging.poll(L, 1, { waitMs: 0, limit: 50 });
    messaging.report(L, grantMessage!.id, { status: 'no_discord_user' });
    expect(leaseRows().map((r) => r.notice_delivery)).toEqual(['no_discord_user', 'no_discord_user']);
    expect(leases.list(L, OWNER).leases.map((l) => l.notice)).toEqual(['no_discord_user', 'no_discord_user']);

    leases.end(L, OWNER, granted[0]!.id);
    const [endMessage] = await messaging.poll(L, 1, { waitMs: 0, limit: 50 });
    messaging.report(L, endMessage!.id, { status: 'delivered' });
    expect(leaseRows()[0]!.notice_delivery).toBe('no_discord_user');
  });
});
