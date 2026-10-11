import { and, asc, eq } from 'drizzle-orm';
import type { PlayerInput } from '../../../shared/schemas/roster';
import type { PlayerId, SessionDate } from '../../../shared/types/ids';
import type { Db } from '../../db/client';
import type { sessionDraft} from '../../db/schema';
import { sessionPlayer, tdfUpload } from '../../db/schema';
import type { SightingsService } from '../metrics/sightings';
import type { Regular, RosterService } from '../roster/service';
import { createDrafts } from './drafts';

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
  /** Tournament files committed for this date, oldest first. */
  imports: SessionImport[];
}

export interface SessionImport {
  uploadId: number;
  filename: string;
  tournamentName: string | null;
  playerCount: number;
  importedAt: Date;
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
  /**
   * Takes the player off the date and retracts their manual and tdf sightings:
   * the organizer is saying they weren't there. False when they weren't listed.
   */
  removePlayer(leagueId: string, date: SessionDate, playerId: PlayerId): boolean;
}

export function createSessionsService(deps: { db: Db; roster: RosterService; sightings: SightingsService }): SessionsService {
  const { db, roster, sightings } = deps;

  const drafts = createDrafts(db);

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

  const committedImports = (draftId: number): SessionImport[] =>
    db
      .select({
        uploadId: tdfUpload.id,
        filename: tdfUpload.filename,
        tournamentName: tdfUpload.tournamentName,
        playerCount: tdfUpload.playerCount,
        importedAt: tdfUpload.committedAt,
      })
      .from(tdfUpload)
      .where(and(eq(tdfUpload.draftId, draftId), eq(tdfUpload.status, 'committed')))
      .orderBy(asc(tdfUpload.committedAt), asc(tdfUpload.id))
      .all() as SessionImport[];

  return {
    getSession(leagueId, date) {
      const draft = drafts.find(leagueId, date);
      return {
        date,
        status: draft?.status ?? 'draft',
        playSessionId: draft?.playSessionId ?? null,
        players: draft ? listedPlayers(leagueId, draft.id) : [],
        regulars: roster.listRegulars(leagueId),
        imports: draft ? committedImports(draft.id) : [],
      };
    },

    addPlayer(leagueId, date, input) {
      return db.transaction(() => {
        if (roster.regularIds(leagueId).has(input.playerId)) throw new AlreadyRegularError(input.playerId);

        roster.ensurePlayers(leagueId, [input]);
        const draft = drafts.ensure(leagueId, date);
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
        const draft = drafts.find(leagueId, date);
        if (!draft) return false;
        const { changes } = db
          .delete(sessionPlayer)
          .where(and(eq(sessionPlayer.draftId, draft.id), eq(sessionPlayer.playerId, playerId)))
          .run();
        if (changes > 0) {
          sightings.retract(leagueId, date, 'manual', [playerId]);
          sightings.retract(leagueId, date, 'tdf', [playerId]);
        }
        return changes > 0;
      });
    },
  };
}

function byName(a: SessionPlayer, b: SessionPlayer): number {
  return a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()) || a.playerId.localeCompare(b.playerId);
}
