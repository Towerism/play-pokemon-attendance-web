// Shim (kit ADR-0007, A4): the token vault is now the kit's string vault, built in server/bootstrap/vaults.ts, and
// TokenVaultError is the kit's VaultError (same class, so catches are unchanged). Deleted once call sites move.
export { type StringVault as TokenVault, VaultError as TokenVaultError } from '@towerism/selfhost-kit';
export { tokenVault as createTokenVault } from '../../../bootstrap/vaults';
