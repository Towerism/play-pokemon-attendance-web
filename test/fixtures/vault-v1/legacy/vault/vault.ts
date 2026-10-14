import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM at rest (ADR-0003, ADR-0012, architecture §9). Each purpose has
 * its own key: `token` (the stored refresh token) and `tdf` (the TDF archive).
 *
 * Blob layout: `version (1) | iv (12) | auth tag (16) | ciphertext`. The caller's
 * AAD binds a ciphertext to the row it was written for. The key never touches
 * the database.
 */
export interface Vault {
  seal(plaintext: Buffer, aad: string): Buffer;
  /** @throws VaultError when the blob is malformed, tampered with, or was sealed with another key or AAD. */
  open(blob: Buffer, aad: string): Buffer;
}

export type VaultPurpose = 'token' | 'tdf';

export class VaultError extends Error {
  override name = 'VaultError';
}

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const LABEL: Record<VaultPurpose, string> = { token: 'token', tdf: 'TDF' };

/** @param base64Key 32 bytes, base64 (`NUXT_TOKEN_VAULT_KEY` / `NUXT_TDF_VAULT_KEY` or their files in `secrets/`). */
export function createVault(base64Key: string, purpose: VaultPurpose): Vault {
  const label = LABEL[purpose];
  const key = BASE64.test(base64Key) ? Buffer.from(base64Key, 'base64') : Buffer.alloc(0);
  if (key.length !== 32) throw new VaultError(`The ${label} vault key must be 32 bytes, base64-encoded.`);

  return {
    seal(plaintext, aad) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(aad, 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
    },

    open(blob, aad) {
      if (blob.length <= HEADER_BYTES || blob[0] !== VERSION) {
        throw new VaultError(`The stored ${label} data is not in a format this version understands.`);
      }
      const iv = blob.subarray(1, 1 + IV_BYTES);
      const tag = blob.subarray(1 + IV_BYTES, HEADER_BYTES);
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(Buffer.from(aad, 'utf8'));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(blob.subarray(HEADER_BYTES)), decipher.final()]);
      } catch (err) {
        throw new VaultError(`The stored ${label} data could not be decrypted (wrong key or tampered data).`, { cause: err });
      }
    },
  };
}
