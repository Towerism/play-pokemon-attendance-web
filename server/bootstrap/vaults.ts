/**
 * Attendance's configuration of the kit's vault (ADR-0003, ADR-0012, ADR-0014, A4): AES-256-GCM, blob v1, one key
 * per purpose. The cipher comes from `@towerism/selfhost-kit`; this module only names each vault, so its messages
 * read "The token vault key…" / "The stored TDF data…" as they always have. Configuration only: the keys reach it
 * from runtime config through `server/utils/pokemon.ts` (token) and `server/utils/tdf-archive.ts` (TDF), and the
 * vaults are injected into the modules. Tests build the same vaults from here.
 *
 * Every caller binds a blob to its row with a non-empty AAD: the kit refuses an empty one.
 */
import { type StringVault, type Vault, createVault, stringVault } from '@towerism/selfhost-kit';

/** The refresh-token cipher (`NUXT_TOKEN_VAULT_KEY` or `secrets/token-vault.key`, 32 bytes, base64). */
export function tokenCipher(key: string): Vault {
  return createVault({ key, label: 'token' });
}

/** The stored refresh tokens, as UTF-8 strings over the token cipher. AAD `pokemon_connection:<id>`. */
export function tokenVault(key: string): StringVault {
  return stringVault(tokenCipher(key));
}

/** The TDF archive (`NUXT_TDF_VAULT_KEY` or `secrets/tdf-vault.key`). AAD `tdf_file:<league>:<sha256>`. */
export function tdfVault(key: string): Vault {
  return createVault({ key, label: 'TDF' });
}
