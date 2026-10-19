import { tdfVault } from '../bootstrap/vaults';
import { createTdfUploadReferrer } from '../modules/sessions/tdf-import';
import { createResultUploadReferrer } from '../modules/tournaments/results';
import type { Actor } from '../modules/accounts/service';
import { mayAccessTdf } from '../modules/tdf-archive/access';
import { TdfFileNotFoundError, TdfKeyMismatchError } from '../modules/tdf-archive/errors';
import { type TdfArchiveService, createTdfArchiveService } from '../modules/tdf-archive/service';

let archive: TdfArchiveService | undefined;

/** The encrypted TDF archive (ADR-0012), with the TDF key from env or `secrets/tdf-vault.key`. */
export function useTdfArchive(): TdfArchiveService {
  archive ??= createTdfArchiveService({
    db: useDb(),
    vault: tdfVault(useRuntimeConfig().tdfVaultKey),
    referrers: () => [createTdfUploadReferrer(useDb()), createResultUploadReferrer(useDb())],
    log: useLogger('tdf-archive'),
  });
  return archive;
}

/** Maps the archive's errors to HTTP; anything else is rethrown unchanged. */
export function tdfArchiveHttpError(err: unknown): unknown {
  if (err instanceof TdfFileNotFoundError) return createError({ statusCode: 404, message: err.message });
  if (err instanceof TdfKeyMismatchError) {
    return createError({ statusCode: 409, message: err.message, data: { code: 'tdf_key_mismatch' } });
  }
  return err;
}

/**
 * Which stored TDFs `actor` may list, download or delete (ADR-0015 §4, §5): every file for the owner; for a professor,
 * files they uploaded or that belong to tournaments one of their own connections organizes, and for downloading, the
 * results files of a tournament lent to them.
 */
export function tdfAccess(leagueId: string, actor: Actor, use: 'list' | 'download' | 'delete' = 'list'): (file: { id: number; createdBy: string }) => boolean {
  if (actor.role === 'owner') return () => true;
  const own = usePokemon()
    .listActingConnections()
    .filter((c) => c.userId === actor.userId && c.professorPlayerId !== null)
    .map((c) => c.professorPlayerId!);
  const results = useTournamentResults();
  const reach = {
    organized: results.fileIdsOrganizedBy(leagueId, own),
    leased: results.fileIdsOfTournaments(leagueId, [...useLeases().leasedTournamentIdsOf(actor.userId)]),
    results: results.resultFileIds(leagueId),
  };
  return (file) => mayAccessTdf(actor, file, reach, use);
}

/** 404 unless `actor` may reach stored file `fileId` for `use`: a file they may not reach answers as one that doesn't exist. */
export function assertTdfAccess(leagueId: string, actor: Actor, fileId: number, use: 'download' | 'delete'): void {
  const file = useTdfArchive().list(leagueId).find((f) => f.id === fileId);
  if (!file || !tdfAccess(leagueId, actor, use)(file)) throw tdfArchiveHttpError(new TdfFileNotFoundError(fileId));
}

