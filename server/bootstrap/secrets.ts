/**
 * Shim (A3, #131): the secret bootstrap comes from `@towerism/selfhost-kit`. Same export names as before,
 * with attendance's three specs configured here. Removed once the call sites use the kit directly.
 */
import { aes256Key, sessionPassword } from '@towerism/selfhost-kit';

export { InvalidSecretError, type SecretSource, type SecretSpec, resolveSecret } from '@towerism/selfhost-kit';

export const SESSION_PASSWORD = sessionPassword();

export const TOKEN_VAULT_KEY = aes256Key({ env: 'NUXT_TOKEN_VAULT_KEY', file: 'token-vault.key', label: 'Token vault key' });

/** The TDF archive's own AES-256-GCM key (ADR-0012): losing it loses the archive, not the Pokémon login. */
export const TDF_VAULT_KEY = aes256Key({ env: 'NUXT_TDF_VAULT_KEY', file: 'tdf-vault.key', label: 'TDF vault key' });
