import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { PlayerInput, PlayerPatch } from '../../../shared/schemas/roster';
import type { PlayerId } from '../../../shared/types/ids';
import type { Db } from '../../db/client';
import { player, playerMembership } from '../../db/schema';

export interface Player {
  playerId: PlayerId;
  /** Empty when no name is known yet. */
  displayName: string;
  isRegular: boolean;
  notes: string | null;
  firstSeenAt: Date;
}

export interface Regular {
  playerId: PlayerId;
  displayName: string;
  regularSince: Date;
  notes: string | null;
}

export class PlayerNotFoundError extends Error {
  override name = 'PlayerNotFoundError';
  constructor(playerId: string) {
    super(`Player ${playerId} is not known in this league.`);
  }
}

export interface RosterService {
  /**
   * Records players as known in the league. A name fills in a missing one but
   * never overwrites an existing name (renames go through `updatePlayer`).
   */
  ensurePlayers(leagueId: string, players: readonly PlayerInput[]): void;
  getPlayers(leagueId: string, playerIds: readonly PlayerId[]): Player[];
  listPlayers(leagueId: string, opts?: { q?: string }): Player[];
  /** @throws PlayerNotFoundError */
  updatePlayer(leagueId: string, playerId: PlayerId, patch: PlayerPatch): Player;

  listRegulars(leagueId: string): Regular[];
  regularIds(leagueId: string): Set<PlayerId>;
  /** Idempotent; `added` is false when the player already was a regular. */
  addRegular(leagueId: string, input: PlayerInput): { added: boolean; regular: Regular };
  /** Keeps the player as a known non-regular. False when they weren't a regular. */
  removeRegular(leagueId: string, playerId: PlayerId): boolean;
  /** One-time import of the CLI's `regulars.json`. All-or-nothing. */
  importRegulars(leagueId: string, players: readonly PlayerInput[]): { added: number; alreadyRegular: number };
}

// Well under SQLite's bound-parameter limit for multi-row statements.
const CHUNK = 300;

export function createRosterService(deps: { db: Db }): RosterService {
  const { db } = deps;

  const selectPlayers = () =>
    db
      .select({
        playerId: player.playerId,
        displayName: player.displayName,
        isRegular: playerMembership.isRegular,
        notes: playerMembership.notes,
        firstSeenAt: player.firstSeenAt,
        regularSince: playerMembership.regularSince,
      })
      .from(playerMembership)
      .innerJoin(player, eq(player.playerId, playerMembership.playerId));

  type Row = Awaited<ReturnType<ReturnType<typeof selectPlayers>['all']>>[number];
  const byName = [asc(sql`lower(${player.displayName})`), asc(player.playerId)];

  const toPlayer = (r: Row): Player => ({
    playerId: r.playerId as PlayerId,
    displayName: r.displayName,
    isRegular: r.isRegular,
    notes: r.notes,
    firstSeenAt: r.firstSeenAt,
  });
  const toRegular = (r: Row): Regular => ({
    playerId: r.playerId as PlayerId,
    displayName: r.displayName,
    regularSince: r.regularSince!,
    notes: r.notes,
  });

  const membership = (leagueId: string, playerId: string) =>
    and(eq(playerMembership.leagueId, leagueId), eq(playerMembership.playerId, playerId));

  const findRow = (leagueId: string, playerId: string) => selectPlayers().where(membership(leagueId, playerId)).get();

  function ensurePlayers(leagueId: string, players: readonly PlayerInput[]) {
    const unique = dedupe(players);
    for (const chunk of chunks(unique)) {
      db.insert(player)
        .values(chunk.map((p) => ({ playerId: p.playerId, displayName: p.name ?? '' })))
        .onConflictDoUpdate({
          target: player.playerId,
          set: { displayName: sql`excluded.display_name` },
          setWhere: sql`${player.displayName} = '' and excluded.display_name <> ''`,
        })
        .run();
      db.insert(playerMembership)
        .values(chunk.map((p) => ({ leagueId, playerId: p.playerId })))
        .onConflictDoNothing()
        .run();
    }
  }

  function makeRegular(leagueId: string, playerIds: readonly string[]): number {
    let changed = 0;
    for (const chunk of chunks(playerIds)) {
      changed += db
        .update(playerMembership)
        .set({ isRegular: true, regularSince: new Date() })
        .where(
          and(
            eq(playerMembership.leagueId, leagueId),
            inArray(playerMembership.playerId, chunk),
            eq(playerMembership.isRegular, false),
          ),
        )
        .run().changes;
    }
    return changed;
  }

  return {
    ensurePlayers: (leagueId, players) => db.transaction(() => ensurePlayers(leagueId, players)),

    getPlayers(leagueId, playerIds) {
      if (playerIds.length === 0) return [];
      return chunks(playerIds).flatMap((chunk) =>
        selectPlayers()
          .where(and(eq(playerMembership.leagueId, leagueId), inArray(playerMembership.playerId, chunk)))
          .all()
          .map(toPlayer),
      );
    },

    listPlayers(leagueId, { q } = {}) {
      // drizzle's like() has no ESCAPE clause, so the search is written out.
      const pattern = q && `%${escapeLike(q.toLowerCase())}%`;
      const search = pattern
        ? sql`(lower(${player.displayName}) like ${pattern} escape '\\' or ${player.playerId} like ${pattern} escape '\\')`
        : undefined;
      return selectPlayers()
        .where(and(eq(playerMembership.leagueId, leagueId), search))
        .orderBy(...byName)
        .all()
        .map(toPlayer);
    },

    updatePlayer(leagueId, playerId, patch) {
      return db.transaction(() => {
        const row = findRow(leagueId, playerId);
        if (!row) throw new PlayerNotFoundError(playerId);

        if (patch.name !== undefined) {
          db.update(player).set({ displayName: patch.name }).where(eq(player.playerId, playerId)).run();
        }
        if (patch.notes !== undefined) {
          db.update(playerMembership).set({ notes: patch.notes }).where(membership(leagueId, playerId)).run();
        }
        if (patch.isRegular === true) makeRegular(leagueId, [playerId]);
        if (patch.isRegular === false) {
          db.update(playerMembership)
            .set({ isRegular: false, regularSince: null })
            .where(membership(leagueId, playerId))
            .run();
        }
        return toPlayer(findRow(leagueId, playerId)!);
      });
    },

    listRegulars(leagueId) {
      return selectPlayers()
        .where(and(eq(playerMembership.leagueId, leagueId), eq(playerMembership.isRegular, true)))
        .orderBy(...byName)
        .all()
        .map(toRegular);
    },

    regularIds(leagueId) {
      const rows = db
        .select({ playerId: playerMembership.playerId })
        .from(playerMembership)
        .where(and(eq(playerMembership.leagueId, leagueId), eq(playerMembership.isRegular, true)))
        .all();
      return new Set(rows.map((r) => r.playerId as PlayerId));
    },

    addRegular(leagueId, input) {
      return db.transaction(() => {
        ensurePlayers(leagueId, [input]);
        const added = makeRegular(leagueId, [input.playerId]) > 0;
        return { added, regular: toRegular(findRow(leagueId, input.playerId)!) };
      });
    },

    removeRegular(leagueId, playerId) {
      const { changes } = db
        .update(playerMembership)
        .set({ isRegular: false, regularSince: null })
        .where(and(membership(leagueId, playerId), eq(playerMembership.isRegular, true)))
        .run();
      return changes > 0;
    },

    importRegulars(leagueId, players) {
      return db.transaction(() => {
        const unique = dedupe(players);
        ensurePlayers(leagueId, unique);
        const added = makeRegular(
          leagueId,
          unique.map((p) => p.playerId),
        );
        return { added, alreadyRegular: unique.length - added };
      });
    },
  };
}

/** One entry per player ID, keeping the first non-empty name. */
function dedupe(players: readonly PlayerInput[]): PlayerInput[] {
  const byId = new Map<string, PlayerInput>();
  for (const p of players) {
    const seen = byId.get(p.playerId);
    if (!seen) byId.set(p.playerId, { ...p });
    else if (!seen.name && p.name) seen.name = p.name;
  }
  return [...byId.values()];
}

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
