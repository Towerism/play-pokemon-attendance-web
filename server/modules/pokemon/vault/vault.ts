import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encrypts the stored refresh token at rest (ADR-0003, architecture §9).
 *
 * Blob layout: `version (1) | iv (12) | auth tag (16) | ciphertext`. The
 * league id is the additional authenticated data, so a ciphertext only opens
 * for the row it was written for. The key never touches the database.
 */
export interface TokenVault {
  encrypt(plaintext: string, leagueId: string): Buffer;
  /** @throws TokenVaultError when the blob is malformed, tampered with, or was sealed with another key. */
  decrypt(blob: Buffer, leagueId: string): string;
}

export class TokenVaultError extends Error {
  override name = 'TokenVaultError';
}

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** @param base64Key 32 bytes, base64 (`NUXT_TOKEN_VAULT_KEY` or `/data/secrets/token-vault.key`). */
export function createTokenVault(base64Key: string): TokenVault {
  const key = BASE64.test(base64Key) ? Buffer.from(base64Key, 'base64') : Buffer.alloc(0);
  if (key.length !== 32) throw new TokenVaultError('The token vault key must be 32 bytes, base64-encoded.');

  return {
    encrypt(plaintext, leagueId) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(leagueId, 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
    },

    decrypt(blob, leagueId) {
      if (blob.length <= HEADER_BYTES || blob[0] !== VERSION) {
        throw new TokenVaultError('The stored token is not in a format this version understands.');
      }
      const iv = blob.subarray(1, 1 + IV_BYTES);
      const tag = blob.subarray(1 + IV_BYTES, HEADER_BYTES);
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(Buffer.from(leagueId, 'utf8'));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(blob.subarray(HEADER_BYTES)), decipher.final()]).toString('utf8');
      } catch (err) {
        throw new TokenVaultError('The stored token could not be decrypted (wrong key or tampered data).', { cause: err });
      }
    },
  };
}
