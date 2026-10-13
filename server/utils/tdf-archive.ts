import { createTdfUploadReferrer } from '../modules/sessions/tdf-import';
import { TdfFileNotFoundError, TdfKeyMismatchError } from '../modules/tdf-archive/errors';
import { type TdfArchiveService, createTdfArchiveService } from '../modules/tdf-archive/service';
import { createVault } from '../modules/vault/vault';

let archive: TdfArchiveService | undefined;

/** The encrypted TDF archive (ADR-0012), with the TDF key from env or `secrets/tdf-vault.key`. */
export function useTdfArchive(): TdfArchiveService {
  archive ??= createTdfArchiveService({
    db: useDb(),
    vault: createVault(useRuntimeConfig().tdfVaultKey, 'tdf'),
    referrers: () => [createTdfUploadReferrer(useDb())],
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
