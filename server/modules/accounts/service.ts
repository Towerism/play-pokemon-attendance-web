import { randomBytes } from 'node:crypto';
import { asc, count, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { appUser } from '../../db/schema';
import { setupCodeMatches } from '@towerism/selfhost-kit';

/** scrypt in production (nuxt-auth-utils `hashPassword` / `verifyPassword`). */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

export interface AppUser {
  id: number;
  username: string;
}

export type Role = 'owner' | 'professor';

/**
 * Who is making a request (ADR-0015 §4), read from the database on every request. Services that write to play-tools
 * take it and get their connection from the pokemon module's `actingConnection`.
 */
export interface Actor {
  userId: number;
  username: string;
  role: Role;
  /**
   * A professor who accepted a password reset link and hasn't completed a Pokémon connect since (ADR-0015 §8): held to
   * the waiting room, and `actingConnection` refuses them. Absent means false.
   */
  reverifyRequired?: boolean;
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
  /** The user for valid credentials, otherwise `null`. A removed user gets `null`, as for a wrong password. Records the sign-in. */
  authenticate(input: { username: string; password: string }): Promise<AppUser | null>;
  /** The actor for a session's user id; `null` when the user is gone or removed. */
  actor(userId: number): Actor | null;
  /** A successful Pokémon connect proved the professor's login after a reset (ADR-0015 §8). */
  clearReverify(userId: number): void;
  /** Every user who isn't removed, oldest first: who a tournament lease can name (ADR-0015 §5). */
  activeActors(): Actor[];
}

export function createAccountsService(deps: {
  db: Db;
  hasher: PasswordHasher;
  /** The code logged on boot, or `null` once setup is no longer possible. */
  setupCode: string | null;
  now?: () => Date;
}): AccountsService {
  const { db, hasher } = deps;
  const now = deps.now ?? (() => new Date());
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
            .values({ username, passwordHash, role: 'owner' })
            .returning({ id: appUser.id, username: appUser.username })
            .get();
        },
        { behavior: 'immediate' },
      );
    },

    async authenticate({ username, password }) {
      const row = db.select().from(appUser).where(eq(appUser.username, username)).get();
      if (!row || row.removedAt) {
        // Same scrypt work as a real check, so response time doesn't reveal which usernames exist.
        dummyHash ??= hasher.hash(randomBytes(16).toString('hex'));
        await hasher.verify(await dummyHash, password);
        return null;
      }
      if (!(await hasher.verify(row.passwordHash, password))) return null;
      db.update(appUser).set({ lastSignInAt: now() }).where(eq(appUser.id, row.id)).run();
      return { id: row.id, username: row.username };
    },

    actor(userId) {
      const row = db
        .select({ username: appUser.username, role: appUser.role, removedAt: appUser.removedAt, reverifyRequiredAt: appUser.reverifyRequiredAt })
        .from(appUser)
        .where(eq(appUser.id, userId))
        .get();
      return row && !row.removedAt ? { userId, username: row.username, role: row.role, reverifyRequired: row.reverifyRequiredAt !== null } : null;
    },

    clearReverify(userId) {
      db.update(appUser).set({ reverifyRequiredAt: null }).where(eq(appUser.id, userId)).run();
    },

    activeActors() {
      return db
        .select({ userId: appUser.id, username: appUser.username, role: appUser.role, reverifyRequiredAt: appUser.reverifyRequiredAt })
        .from(appUser)
        .where(isNull(appUser.removedAt))
        .orderBy(asc(appUser.id))
        .all()
        .map(({ reverifyRequiredAt, ...a }) => ({ ...a, reverifyRequired: reverifyRequiredAt !== null }));
    },
  };
}
