export class TdfFileNotFoundError extends Error {
  override name = 'TdfFileNotFoundError';
  constructor(fileId: number) {
    super(`TDF file ${fileId} was not found.`);
  }
}

/** The stored file doesn't open with this install's TDF key (a lost or replaced key, or tampered data). */
export class TdfKeyMismatchError extends Error {
  override name = 'TdfKeyMismatchError';
  constructor(fileId: number) {
    super(`TDF file ${fileId} can't be opened with this install's key.`);
  }
}
