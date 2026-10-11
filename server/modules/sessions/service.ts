import { and, eq } from 'drizzle-orm';
import type { PlayerInput } from '../../../shared/schemas/roster';
import type { PlayerId, SessionDate } from '../../../shared/types/ids';
import type { Db } from '../../db/client';
import { sessionDraft, sessionPlayer } from '../../db/schema';
import type { SightingsService } from '../metrics/sightings';
import type { Regular, RosterService } from '../roster/service';

export type SessionStatus = (typeof sessionDraft.$inferSelect)['status'];

export interface SessionPlayer {
  playerId: PlayerId;
  displayName: string;
  source: 'tdf' | 'manual';
}

export interface SessionView {
  date: SessionDate;
  status: SessionStatus;
  playSessionId: string | null;
  /** Non-regulars listed for this date. */
  players: SessionPlayer[];
  /** Submitted every session alongside `players`. */
  regulars: Regular[];
}

export class AlreadyRegularError extends Error {
  override name = 'AlreadyRegularError';
  constructor(playerId: string) {
    super(`Player ${playerId} is a regular and is already submitted every session.`);
  }
}

export interface SessionsService {
  /** The draft for a date; an untouched date reads as an empty draft (nothing is created). */
  getSession(leagueId: string, date: SessionDate): SessionView;
  /**
   * Lists a player for the date by hand and records a manual sighting.
   * Idempotent; `added` is false when they were already listed.
   * @throws AlreadyRegularError
   */
  addPlayer(leagueId: string, date: SessionDate, input: PlayerInput): { added: boolean; player: SessionPlayer };
  /** Takes the player off the date and retracts the manual sighting. False when they weren't listed. */
  removePlayer(leagueId: string, date: SessionDate, playerId: PlayerId): boolean;
}

export function createSessionsService(deps: { db: Db; roster: RosterService; sightings: SightingsService }): SessionsService {
  const { db, roster, sightings } = deps;

  const findDraft = (leagueId: string, date: SessionDate) =>
    db
      .select()
      .from(sessionDraft)
      .where(and(eq(sessionDraft.leagueId, leagueId), eq(sessionDraft.sessionDate, date)))
      .get();

  const ensureDraft = (leagueId: string, date: SessionDate) => {
    db.insert(sessionDraft).values({ leagueId, sessionDate: date }).onConflictDoNothing().run();
    return findDraft(leagueId, date)!;
  };

  const listedPlayers = (leagueId: string, draftId: number): SessionPlayer[] => {
    const rows = db
      .select({ playerId: sessionPlayer.playerId, source: sessionPlayer.source })
      .from(sessionPlayer)
      .where(eq(sessionPlayer.draftId, draftId))
      .all();
    const names = new Map(roster.getPlayers(leagueId, rows.map((r) => r.playerId as PlayerId)).map((p) => [p.playerId, p.displayName]));
    return rows
      .map((r) => ({ playerId: r.playerId as PlayerId, displayName: names.get(r.playerId as PlayerId) ?? '', source: r.source }))
      .sort(byName);
  };

  return {
    getSession(leagueId, date) {
      const draft = findDraft(leagueId, date);
      return {
        date,
        status: draft?.status ?? 'draft',
        playSessionId: draft?.playSessionId ?? null,
        players: draft ? listedPlayers(leagueId, draft.id) : [],
        regulars: roster.listRegulars(leagueId),
      };
    },

    addPlayer(leagueId, date, input) {
      return db.transaction(() => {
        if (roster.regularIds(leagueId).has(input.playerId)) throw new AlreadyRegularError(input.playerId);

        roster.ensurePlayers(leagueId, [input]);
        const draft = ensureDraft(leagueId, date);
        const { changes } = db
          .insert(sessionPlayer)
          .values({ draftId: draft.id, playerId: input.playerId, source: 'manual' })
          .onConflictDoNothing()
          .run();
        if (changes > 0) sightings.record(leagueId, date, 'manual', [input.playerId]);

        const player = listedPlayers(leagueId, draft.id).find((p) => p.playerId === input.playerId)!;
        return { added: changes > 0, player };
      });
    },

    removePlayer(leagueId, date, playerId) {
      return db.transaction(() => {
        const draft = findDraft(leagueId, date);
        if (!draft) return false;
        const { changes } = db
          .delete(sessionPlayer)
          .where(and(eq(sessionPlayer.draftId, draft.id), eq(sessionPlayer.playerId, playerId)))
          .run();
        if (changes > 0) sightings.retract(leagueId, date, 'manual', [playerId]);
        return changes > 0;
      });
    },
  };
}

function byName(a: SessionPlayer, b: SessionPlayer): number {
  return a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()) || a.playerId.localeCompare(b.playerId);
}
