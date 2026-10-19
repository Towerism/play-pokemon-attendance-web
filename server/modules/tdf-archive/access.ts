import type { Actor } from '../accounts/service';

/**
 * Whether `actor` may list, download or delete a stored TDF (ADR-0015 §4). The files hold minors' birthdates, so a
 * professor reaches only files they uploaded, or files of a results upload for a tournament they organize
 * (`organized`, from the tournaments module). The owner reaches every file.
 */
export function mayAccessTdf(actor: Actor, file: { id: number; createdBy: string }, organized: ReadonlySet<number>): boolean {
  return actor.role === 'owner' || file.createdBy === actor.username || organized.has(file.id);
}
