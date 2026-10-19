import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { messageVault } from '../../bootstrap/vaults';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import { type MessagingService, createMessagingService } from '../messaging/channel';
import type { HeldConnection } from '../pokemon/connection';
import { type InviteService, createInviteService } from './invites';
import { type ProfessorsService, createProfessorsService } from './professors';
import type { Actor } from './service';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const T0 = new Date('2026-10-19T12:00:00Z');

let database: OpenDatabase;
let messaging: MessagingService;
let invites: InviteService;
let professors: ProfessorsService;
let owner: Actor;
/** The pokemon module as the professors service sees it: connections by user, and the removal steps it records. */
let held: Map<number, HeldConnection>;
let steps: string[];

const user = (id: number) => database.sqlite.prepare('select * from app_user where id = ?').get(id) as Record<string, unknown>;

function addUser(username: string, opts: { role?: 'owner' | 'professor'; removed?: boolean; lastSignIn?: number; reverify?: boolean } = {}): number {
  return (
    database.sqlite
      .prepare(
        `insert into app_user (username, password_hash, role, removed_at, last_sign_in_at, reverify_required_at, created_at) values (?, 'h', ?, ?, ?, ?, ?) returning id`,
      )
      .get(username, opts.role ?? 'professor', opts.removed ? 1 : null, opts.lastSignIn ?? null, opts.reverify ? 1 : null, T0.getTime() / 1000) as { id: number }
  ).id;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T0);
  database = openDatabase(':memory:');
  migrateDatabase(database.db, MIGRATIONS_DIR);
  messaging = createMessagingService({ db: database.db, vault: messageVault(Buffer.alloc(32, 3).toString('base64')), leagueId: L });
  held = new Map();
  steps = [];
  const connections = {
    ownerConnectionCount: () => 1,
    recipientOf: (id: number) => held.get(id)?.playerId ?? null,
    connectionOf: (id: number) => held.get(id) ?? null,
    prepareRemoval: (id: number) => {
      steps.push(`read tokens of ${id}`);
      return {
        revoke: async () => {
          steps.push(`revoked tokens of ${id}, removed_at ${user(id).removed_at === null ? 'unset' : 'set'}`);
        },
      };
    },
    deleteConnectionsOf: (id: number) => {
      steps.push(`deleted connections of ${id}`);
      held.delete(id);
    },
  };
  invites = createInviteService({
    db: database.db,
    hasher: { hash: async (p) => `hashed:${p}`, verify: async () => false },
    channel: messaging,
    connections,
    leagueId: L,
    leagueName: () => 'Card Shop',
    timeZone: 'America/Chicago',
    siteUrl: 'https://league.example',
    sendWaitMs: 10_000,
  });
  professors = createProfessorsService({ db: database.db, invites, connections, channel: messaging });
  owner = { userId: addUser('organizer', { role: 'owner' }), username: 'organizer', role: 'owner' };
});
afterEach(() => {
  messaging.drain();
  database.close();
  vi.useRealTimers();
});

describe('list', () => {
  it('shows every active professor with their connection, the open invites, the seats and whether Genie is connected', async () => {
    const misty = addUser('misty', { lastSignIn: T0.getTime() / 1000 - 60 });
    const brock = addUser('brock', { reverify: true });
    addUser('gary', { removed: true });
    held.set(misty, { playerId: '0000444', name: 'Misty', status: 'connected', membership: 'member', claimedAt: new Date(T0.getTime() - 3_600_000) });
    const { invite } = await invites.mint(owner, { label: 'Erika', send: 'copy' });

    expect(professors.list()).toEqual({
      professors: [
        { userId: brock, username: 'brock', createdAt: T0.toISOString(), lastSignInAt: null, reverifyRequired: true, connection: null },
        {
          userId: misty,
          username: 'misty',
          createdAt: T0.toISOString(),
          lastSignInAt: new Date(T0.getTime() - 60_000).toISOString(),
          reverifyRequired: false,
          connection: { playerId: '0000444', name: 'Misty', status: 'connected', membership: 'member', claimedAt: new Date(T0.getTime() - 3_600_000).toISOString() },
        },
      ],
      invites: [invite],
      seats: { used: 1 + 2 + 1, max: 10 },
      genie: { available: false },
    });
  });

  it('says Genie is connected once it has polled', async () => {
    await messaging.poll(L, 1, { waitMs: 0, limit: 20 });
    expect(professors.list().genie).toEqual({ available: true });
  });
});

describe('remove', () => {
  it('marks the professor removed, revokes their reset links and deletes their connection together, then revokes the login at Pokémon', async () => {
    const misty = addUser('misty');
    held.set(misty, { playerId: '0000444', name: null, status: 'connected', membership: 'member', claimedAt: null });
    const reset = await invites.mintReset(owner, misty, 'copy');

    await professors.remove(misty);

    expect(user(misty).removed_at).toBe(T0.getTime() / 1000);
    expect(user(misty).username).toBe('misty');
    expect(invites.openInvites()).toEqual([]);
    expect((database.sqlite.prepare('select revoked_at from app_invite where id = ?').get(reset.invite.id) as { revoked_at: number }).revoked_at).not.toBeNull();
    expect(steps).toEqual([`read tokens of ${misty}`, `deleted connections of ${misty}`, `revoked tokens of ${misty}, removed_at set`]);
    expect(professors.list().professors).toEqual([]);
  });

  it('rolls everything back when a step fails, so a removed professor never keeps a connection', async () => {
    const misty = addUser('misty');
    const broken = createProfessorsService({
      db: database.db,
      invites,
      connections: {
        connectionOf: () => null,
        prepareRemoval: () => ({ revoke: async () => undefined }),
        deleteConnectionsOf: () => {
          throw new Error('disk full');
        },
      },
      channel: messaging,
    });

    await expect(broken.remove(misty)).rejects.toThrow('disk full');
    expect(user(misty).removed_at).toBeNull();
  });

  it('changes nothing for a professor already removed', async () => {
    const gary = addUser('gary', { removed: true });
    await professors.remove(gary);
    expect(user(gary).removed_at).toBe(1);
    expect(steps).toEqual([]);
  });

  it.each([
    ['the owner', () => owner.userId],
    ['an unknown user', () => 999],
  ])('refuses %s', async (_who, id) => {
    await expect(professors.remove(id())).rejects.toMatchObject({ code: 'professor_not_found' });
  });
});
