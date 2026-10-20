import { type Logger, silentLogger } from '@towerism/selfhost-kit';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { appUser } from '../../db/schema';
import type { DiscordChannel } from '../messaging/channel';
import type { PokemonConnectionService } from '../pokemon/connection';
import { InviteError, type InviteService, type InviteView, MAX_SEATS } from './invites';

/** Settings → Professors, for the owner (ADR-0015 §8). Never carries a secret, hash or token. */
export interface ProfessorsList {
  professors: {
    userId: number;
    username: string;
    createdAt: string;
    lastSignInAt: string | null;
    reverifyRequired: boolean;
    connection: null | {
      playerId: string | null;
      name: string | null;
      status: 'connected' | 'needs_reconnect';
      membership: 'member' | 'outside' | 'unknown';
      claimedAt: string | null;
    };
  }[];
  invites: InviteView[];
  seats: { used: number; max: number };
  genie: { available: boolean };
}

export interface ProfessorsService {
  list(): ProfessorsList;
  /**
   * Removes a professor (ADR-0015 §8): in one transaction, marks them removed, revokes their open reset links and
   * deletes their connection; then revokes its login at Pokémon, best effort. @throws InviteError `professor_not_found`
   */
  remove(userId: number): Promise<void>;
}

export interface ProfessorsDeps {
  db: Db;
  invites: Pick<InviteService, 'openInvites' | 'seatsUsed' | 'revokeResetLinksOf'>;
  connections: Pick<PokemonConnectionService, 'connectionOf' | 'prepareRemoval' | 'deleteConnectionsOf'>;
  channel: Pick<DiscordChannel, 'available'>;
  /** A removed professor's calendar feed is deleted with them (ADR-0016 §1). */
  calendar?: { deleteUserFeeds(userId: number): void };
  now?: () => Date;
  log?: Pick<Logger, 'info'>;
}

export function createProfessorsService(deps: ProfessorsDeps): ProfessorsService {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? silentLogger;

  return {
    list() {
      const rows = db
        .select()
        .from(appUser)
        .where(and(eq(appUser.role, 'professor'), isNull(appUser.removedAt)))
        .orderBy(asc(appUser.username))
        .all();
      return {
        professors: rows.map((u) => {
          const c = deps.connections.connectionOf(u.id);
          return {
            userId: u.id,
            username: u.username,
            createdAt: u.createdAt.toISOString(),
            lastSignInAt: u.lastSignInAt?.toISOString() ?? null,
            reverifyRequired: u.reverifyRequiredAt !== null,
            connection: c && { ...c, claimedAt: c.claimedAt?.toISOString() ?? null },
          };
        }),
        invites: deps.invites.openInvites(),
        seats: { used: deps.invites.seatsUsed(), max: MAX_SEATS },
        genie: { available: deps.channel.available() },
      };
    },

    async remove(userId) {
      const u = db.select().from(appUser).where(eq(appUser.id, userId)).get();
      if (!u || u.role !== 'professor') throw new InviteError('professor_not_found', `No professor ${userId}.`);
      if (u.removedAt) return;
      const playerId = deps.connections.connectionOf(userId)?.playerId ?? null;
      // The tokens are read while the rows exist, and revoked only once the removal has committed.
      const removal = deps.connections.prepareRemoval(userId);
      db.transaction(
        () => {
          db.update(appUser).set({ removedAt: now() }).where(eq(appUser.id, userId)).run();
          deps.invites.revokeResetLinksOf(userId);
          deps.calendar?.deleteUserFeeds(userId);
          deps.connections.deleteConnectionsOf(userId);
        },
        { behavior: 'immediate' },
      );
      log.info('professor removed', { username: u.username, professorPlayerId: playerId });
      await removal.revoke();
    },
  };
}
