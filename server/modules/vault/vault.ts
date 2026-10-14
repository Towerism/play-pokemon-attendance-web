// Shim (kit ADR-0007, A4): the vault now comes from @towerism/selfhost-kit, built in server/bootstrap/vaults.ts.
// Same export names as before, so the existing tests run unchanged against the kit. Deleted once call sites move.
import { tdfVault, tokenCipher } from '../../bootstrap/vaults';
import type { Vault } from '@towerism/selfhost-kit';

export { type Vault, VaultError } from '@towerism/selfhost-kit';

export type VaultPurpose = 'token' | 'tdf';

/** @param base64Key 32 bytes, base64 (`NUXT_TOKEN_VAULT_KEY` / `NUXT_TDF_VAULT_KEY` or their files in `secrets/`). */
export function createVault(base64Key: string, purpose: VaultPurpose): Vault {
  return purpose === 'tdf' ? tdfVault(base64Key) : tokenCipher(base64Key);
}
