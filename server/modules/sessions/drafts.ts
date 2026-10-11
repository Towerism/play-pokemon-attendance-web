import { and, eq } from 'drizzle-orm';
import type { SessionDate } from '../../../shared/types/ids';
import type { Db } from '../../db/client';
import { sessionDraft } from '../../db/schema';

export type Draft = typeof sessionDraft.$inferSelect;

/** Session drafts, one per league and date; internal to the sessions module. */
export function createDrafts(db: Db) {
  const find = (leagueId: string, date: SessionDate): Draft | undefined =>
    db
      .select()
      .from(sessionDraft)
      .where(and(eq(sessionDraft.leagueId, leagueId), eq(sessionDraft.sessionDate, date)))
      .get();

  return {
    find,
    /** The draft for the date, created if this is the first change to it. */
    ensure(leagueId: string, date: SessionDate): Draft {
      db.insert(sessionDraft).values({ leagueId, sessionDate: date }).onConflictDoNothing().run();
      return find(leagueId, date)!;
    },
  };
}
