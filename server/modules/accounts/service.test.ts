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
  accounts = createAccountsService({ db: database.db, hasher, setupCode: CODE });
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
});
