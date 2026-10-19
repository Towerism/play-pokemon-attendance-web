import type { Actor } from '../accounts/service';

/** Which stored files reach a professor, besides the ones they uploaded, as file ids from the tournaments module. */
export interface TdfReach {
  /** Files of results uploads for tournaments one of their own connections organizes. */
  organized: ReadonlySet<number>;
  /** Files of results uploads for tournaments they hold a live lease on (ADR-0015 §5). */
  leased: ReadonlySet<number>;
  /** Every file that belongs to a results upload. */
  results: ReadonlySet<number>;
}

/**
 * Whether `actor` may list, download or delete a stored TDF (ADR-0015 §4, §5). The files hold minors' birthdates, so a
 * professor reaches only files they uploaded, or files of a results upload for a tournament they organize. A lent
 * professor may also download the leased tournament's results files, but neither lists nor deletes them, and nobody but
 * the organizer deletes a results file, even one they uploaded under a lease. The owner reaches every file.
 */
export function mayAccessTdf(actor: Actor, file: { id: number; createdBy: string }, reach: TdfReach, use: 'list' | 'download' | 'delete'): boolean {
  if (actor.role === 'owner' || reach.organized.has(file.id)) return true;
  const uploaded = file.createdBy === actor.username;
  if (use === 'delete') return uploaded && !reach.results.has(file.id);
  if (use === 'download' && reach.leased.has(file.id)) return true;
  return uploaded;
}
