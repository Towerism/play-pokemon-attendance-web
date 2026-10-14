import { VaultError, createVault } from '../../vault/vault';

/**
 * Encrypts the stored refresh token at rest (ADR-0003, architecture §9), with
 * the shared AES-256-GCM vault. The league id is the additional authenticated
 * data, so a ciphertext only opens for the row it was written for.
 */
export interface TokenVault {
  encrypt(plaintext: string, leagueId: string): Buffer;
  /** @throws TokenVaultError when the blob is malformed, tampered with, or was sealed with another key. */
  decrypt(blob: Buffer, leagueId: string): string;
}

export class TokenVaultError extends Error {
  override name = 'TokenVaultError';
}

/** @param base64Key 32 bytes, base64 (`NUXT_TOKEN_VAULT_KEY` or `/data/secrets/token-vault.key`). */
export function createTokenVault(base64Key: string): TokenVault {
  const vault = rethrow(() => createVault(base64Key, 'token'));
  return {
    encrypt: (plaintext, leagueId) => vault.seal(Buffer.from(plaintext, 'utf8'), leagueId),
    decrypt: (blob, leagueId) => rethrow(() => vault.open(blob, leagueId)).toString('utf8'),
  };
}

function rethrow<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof VaultError) throw new TokenVaultError(err.message, { cause: err });
    throw err;
  }
}
