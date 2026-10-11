import { and, asc, eq, inArray } from 'drizzle-orm';
import type { PlayerId, SessionDate } from '../../../shared/types/ids';
import type { Db } from '../../db/client';
import { sighting } from '../../db/schema';

/** Evidence of attendance (ADR-0005): in a TDF, added by hand, or already recorded upstream. */
export type SightingKind = 'tdf' | 'manual' | 'upstream_existing';

export interface Sighting {
  playerId: PlayerId;
  kind: SightingKind;
}

export interface SightingsService {
  /** Idempotent per (player, date, kind). Players must already be known (roster). */
  record(leagueId: string, date: SessionDate, kind: SightingKind, playerIds: readonly PlayerId[]): void;
  retract(leagueId: string, date: SessionDate, kind: SightingKind, playerIds: readonly PlayerId[]): void;
  on(leagueId: string, date: SessionDate): Sighting[];
}

export function createSightingsService(deps: { db: Db }): SightingsService {
  const { db } = deps;

  return {
    record(leagueId, date, kind, playerIds) {
      if (playerIds.length === 0) return;
      db.insert(sighting)
        .values(playerIds.map((playerId) => ({ leagueId, playerId, sessionDate: date, kind })))
        .onConflictDoNothing()
        .run();
    },

    retract(leagueId, date, kind, playerIds) {
      if (playerIds.length === 0) return;
      db.delete(sighting)
        .where(
          and(
            eq(sighting.leagueId, leagueId),
            eq(sighting.sessionDate, date),
            eq(sighting.kind, kind),
            inArray(sighting.playerId, [...playerIds]),
          ),
        )
        .run();
    },

    on(leagueId, date) {
      return db
        .select({ playerId: sighting.playerId, kind: sighting.kind })
        .from(sighting)
        .where(and(eq(sighting.leagueId, leagueId), eq(sighting.sessionDate, date)))
        .orderBy(asc(sighting.playerId), asc(sighting.kind))
        .all() as Sighting[];
    },
  };
}
