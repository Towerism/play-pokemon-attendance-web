import { and, asc, eq } from 'drizzle-orm';
import type { PlayerInput } from '../../../shared/schemas/roster';
import type { PlayerId, SessionDate } from '../../../shared/types/ids';
import type { Db } from '../../db/client';
import { sessionDraft, sessionPlayer, tdfUpload } from '../../db/schema';
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
  regulars: SessionRegular[];
  /** Tournament files committed for this date, oldest first. */
  imports: SessionImport[];
}

/** Whether there is evidence the regular came (ADR-0005); being submitted is not evidence. */
export interface RegularPresence {
  /** A tdf or manual sighting for the date. */
  present: boolean;
  /** In a tournament imported for the date; unticking "present" can't undo that. */
  inTournament: boolean;
}

export type SessionRegular = Regular & RegularPresence;

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

export class NotARegularError extends Error {
  override name = 'NotARegularError';
  constructor(playerId: string) {
    super(`Player ${playerId} is not a regular.`);
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
  /**
   * Ticks a regular "present" (or not) for the date: a manual sighting, so
   * regulars who skip the tournament still count as attending. Idempotent.
   * @throws NotARegularError
   */
  setRegularPresent(leagueId: string, date: SessionDate, playerId: PlayerId, present: boolean): RegularPresence;
  /** The submission module reports the upstream play session it resolved and how the submission is going. */
  recordSubmission(leagueId: string, date: SessionDate, state: { playSessionId: string; status: SessionStatus }): void;
  /**
   * After a play session was cleared in play-tools: the draft goes back to
   * `draft`, and its committed TDF imports are dropped so the same file can be
   * imported again. A no-op when the date has no draft.
   */
  resetAfterClear(leagueId: string, date: SessionDate): void;
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

  const regularsOn = (leagueId: string, date: SessionDate): SessionRegular[] => {
    const of = presence(leagueId, date);
    return roster.listRegulars(leagueId).map((r) => ({ ...r, ...of(r.playerId) }));
  };

  const presence = (leagueId: string, date: SessionDate) => {
    const on = sightings.on(leagueId, date);
    const has = (kinds: string[]) => new Set(on.filter((s) => kinds.includes(s.kind)).map((s) => s.playerId));
    const present = has(['tdf', 'manual']);
    const inTournament = has(['tdf']);
    return (playerId: PlayerId): RegularPresence => ({ present: present.has(playerId), inTournament: inTournament.has(playerId) });
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
        regulars: regularsOn(leagueId, date),
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

    setRegularPresent(leagueId, date, playerId, present) {
      return db.transaction(() => {
        if (!roster.regularIds(leagueId).has(playerId)) throw new NotARegularError(playerId);
        if (present) sightings.record(leagueId, date, 'manual', [playerId]);
        else sightings.retract(leagueId, date, 'manual', [playerId]);
        return presence(leagueId, date)(playerId);
      });
    },

    recordSubmission(leagueId, date, state) {
      const draft = drafts.ensure(leagueId, date);
      db.update(sessionDraft).set(state).where(eq(sessionDraft.id, draft.id)).run();
    },

    resetAfterClear(leagueId, date) {
      db.transaction(() => {
        const draft = drafts.find(leagueId, date);
        if (!draft) return;
        db.update(sessionDraft).set({ status: 'draft' }).where(eq(sessionDraft.id, draft.id)).run();
        db.delete(tdfUpload)
          .where(and(eq(tdfUpload.draftId, draft.id), eq(tdfUpload.status, 'committed')))
          .run();
      });
    },
  };
}

function byName(a: SessionPlayer, b: SessionPlayer): number {
  return a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()) || a.playerId.localeCompare(b.playerId);
}
