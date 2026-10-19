import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import {
  type AccountsService,
  InvalidSetupCodeError,
  type PasswordHasher,
  SetupClosedError,
  createAccountsService,
} from './service';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const CODE = 'ABCD-EFGH';
const NOW = new Date('2026-10-19T12:00:00Z');

/** Reversible stand-in for scrypt; async like the real one. */
const fakeHasher = (): PasswordHasher => ({
  hash: vi.fn(async (pw: string) => `hashed:${pw}`),
  verify: vi.fn(async (hash: string, pw: string) => hash === `hashed:${pw}`),
});

let database: OpenDatabase;
let hasher: PasswordHasher;
let accounts: AccountsService;

beforeEach(() => {
  database = openDatabase(':memory:');
  migrateDatabase(database.db, MIGRATIONS_DIR);
  hasher = fakeHasher();
  accounts = createAccountsService({ db: database.db, hasher, setupCode: CODE, now: () => NOW });
});
afterEach(() => database.close());

const owner = { setupCode: CODE, username: 'organizer', password: 'correct horse' };

describe('first-run setup', () => {
  it('is needed while no account exists', () => {
    expect(accounts.needsSetup()).toBe(true);
  });

  it('creates the organizer account with the right code and then closes', async () => {
    const user = await accounts.setup(owner);

    expect(user).toEqual({ id: expect.any(Number), username: 'organizer' });
    expect(accounts.needsSetup()).toBe(false);
  });

  it('makes the setup account the owner', async () => {
    const user = await accounts.setup(owner);

    expect(accounts.actor(user.id)).toEqual({ userId: user.id, username: 'organizer', role: 'owner' });
  });

  it('stores only the password hash', async () => {
    await accounts.setup(owner);
    const row = database.sqlite.prepare('select password_hash from app_user').get() as { password_hash: string };

    expect(row.password_hash).toBe('hashed:correct horse');
  });

  it('rejects a wrong setup code and creates nothing', async () => {
    await expect(accounts.setup({ ...owner, setupCode: 'WXYZ-2345' })).rejects.toBeInstanceOf(InvalidSetupCodeError);
    expect(accounts.needsSetup()).toBe(true);
  });

  it('refuses a second setup even with the right code', async () => {
    await accounts.setup(owner);

    await expect(accounts.setup({ ...owner, username: 'intruder' })).rejects.toBeInstanceOf(SetupClosedError);
    expect(database.sqlite.prepare('select count(*) n from app_user').get()).toEqual({ n: 1 });
  });

  it('lets exactly one of two concurrent setups win', async () => {
    const results = await Promise.allSettled([
      accounts.setup({ ...owner, username: 'first' }),
      accounts.setup({ ...owner, username: 'second' }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(SetupClosedError);
    expect(database.sqlite.prepare('select count(*) n from app_user').get()).toEqual({ n: 1 });
  });

  it('works without a setup code only by failing closed', async () => {
    const noCode = createAccountsService({ db: database.db, hasher, setupCode: null });
    await expect(noCode.setup(owner)).rejects.toBeInstanceOf(InvalidSetupCodeError);
  });
});

describe('authenticate', () => {
  beforeEach(async () => {
    await accounts.setup(owner);
  });

  it('returns the user for the right password', async () => {
    expect(await accounts.authenticate({ username: 'organizer', password: 'correct horse' })).toEqual({
      id: expect.any(Number),
      username: 'organizer',
    });
  });

  it('returns null for a wrong password', async () => {
    expect(await accounts.authenticate({ username: 'organizer', password: 'wrong' })).toBeNull();
  });

  it('returns null for an unknown user after doing the same hashing work (no user enumeration by timing)', async () => {
    vi.mocked(hasher.verify).mockClear();

    expect(await accounts.authenticate({ username: 'nobody', password: 'correct horse' })).toBeNull();
    expect(hasher.verify).toHaveBeenCalledTimes(1);
  });

  it('records when the user signed in', async () => {
    await accounts.authenticate({ username: 'organizer', password: 'correct horse' });

    expect(database.sqlite.prepare('select last_sign_in_at from app_user').get()).toEqual({ last_sign_in_at: NOW.getTime() / 1000 });
  });

  it('records nothing for a wrong password', async () => {
    await accounts.authenticate({ username: 'organizer', password: 'wrong' });

    expect(database.sqlite.prepare('select last_sign_in_at from app_user').get()).toEqual({ last_sign_in_at: null });
  });

  it('refuses a removed user exactly as a wrong password, after the same hashing work', async () => {
    addProfessor('misty', { removed: true });
    vi.mocked(hasher.verify).mockClear();

    expect(await accounts.authenticate({ username: 'misty', password: 'correct horse' })).toBeNull();
    expect(hasher.verify).toHaveBeenCalledTimes(1);
    expect(database.sqlite.prepare(`select last_sign_in_at from app_user where username = 'misty'`).get()).toEqual({ last_sign_in_at: null });
  });

  it('signs in an active professor', async () => {
    const id = addProfessor('misty');

    expect(await accounts.authenticate({ username: 'misty', password: 'correct horse' })).toEqual({ id, username: 'misty' });
  });
});

describe('the actor behind a session', () => {
  it('reads the role from the database', async () => {
    const { id } = await accounts.setup(owner);
    const prof = addProfessor('misty');

    expect(accounts.actor(id)).toEqual({ userId: id, username: 'organizer', role: 'owner' });
    expect(accounts.actor(prof)).toEqual({ userId: prof, username: 'misty', role: 'professor' });
  });

  it('is null for a removed user, whatever their session says', () => {
    const prof = addProfessor('misty', { removed: true });

    expect(accounts.actor(prof)).toBeNull();
  });

  it('is null for a user id that does not exist', () => {
    expect(accounts.actor(42)).toBeNull();
  });
});

/** A professor row as #202's invites will make them; same password as the owner. */
function addProfessor(username: string, opts: { removed?: boolean } = {}): number {
  const row = database.sqlite
    .prepare(`insert into app_user (username, password_hash, role, removed_at, created_at) values (?, 'hashed:correct horse', 'professor', ?, 1) returning id`)
    .get(username, opts.removed ? 1 : null) as { id: number };
  return row.id;
}
