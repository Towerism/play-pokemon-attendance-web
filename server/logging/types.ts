/**
 * Shim (kit ADR-0007 step A2): the logger port now comes from `@towerism/selfhost-kit`.
 * Removed once call sites switch.
 */
export { type LogFields, type Logger, silentLogger } from '@towerism/selfhost-kit';
