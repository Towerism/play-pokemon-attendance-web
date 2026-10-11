import { randomBytes } from 'node:crypto';
import { count, eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { appUser } from '../../db/schema';
import { setupCodeMatches } from './setup-code';

/** scrypt in production (nuxt-auth-utils `hashPassword` / `verifyPassword`). */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

export interface AppUser {
  id: number;
  username: string;
}

export class SetupClosedError extends Error {
  override name = 'SetupClosedError';
  constructor() {
    super('Setup is closed: an account already exists.');
  }
}

export class InvalidSetupCodeError extends Error {
  override name = 'InvalidSetupCodeError';
  constructor() {
    super('The setup code is wrong. Copy it from the container log.');
  }
}

export interface AccountsService {
  /** True while no account exists: the app shows first-run setup. */
  needsSetup(): boolean;
  /** Creates the organizer account. Inputs are already validated (`SetupBody`). */
  setup(input: { setupCode: string; username: string; password: string }): Promise<AppUser>;
  /** The user for valid credentials, otherwise `null`. */
  authenticate(input: { username: string; password: string }): Promise<AppUser | null>;
}

export function createAccountsService(deps: {
  db: Db;
  hasher: PasswordHasher;
  /** The code logged on boot, or `null` once setup is no longer possible. */
  setupCode: string | null;
}): AccountsService {
  const { db, hasher } = deps;
  let dummyHash: Promise<string> | undefined;

  const userCount = (tx: Pick<Db, 'select'> = db) => tx.select({ n: count() }).from(appUser).get()?.n ?? 0;

  return {
    needsSetup: () => userCount() === 0,

    async setup({ setupCode, username, password }) {
      if (userCount() > 0) throw new SetupClosedError();
      if (!deps.setupCode || !setupCodeMatches(deps.setupCode, setupCode)) throw new InvalidSetupCodeError();

      const passwordHash = await hasher.hash(password);
      // Re-check inside a write transaction: another setup may have finished while we hashed.
      return db.transaction(
        (tx) => {
          if (userCount(tx) > 0) throw new SetupClosedError();
          return tx
            .insert(appUser)
            .values({ username, passwordHash })
            .returning({ id: appUser.id, username: appUser.username })
            .get();
        },
        { behavior: 'immediate' },
      );
    },

    async authenticate({ username, password }) {
      const row = db.select().from(appUser).where(eq(appUser.username, username)).get();
      if (!row) {
        // Same scrypt work as a real check, so response time doesn't reveal which usernames exist.
        dummyHash ??= hasher.hash(randomBytes(16).toString('hex'));
        await hasher.verify(await dummyHash, password);
        return null;
      }
      return (await hasher.verify(row.passwordHash, password)) ? { id: row.id, username: row.username } : null;
    },
  };
}
