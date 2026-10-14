/**
 * Shim (kit ADR-0007 step A2): log redaction now comes from `@towerism/selfhost-kit`,
 * configured here with attendance's extra keys. Removed once call sites switch.
 */
import { BASE_SENSITIVE_KEYS, createRedactor } from '@towerism/selfhost-kit';

export { REDACTED } from '@towerism/selfhost-kit';

const EXTRA_KEYS = [
  'birthdate',
  'dateOfBirth',
  'dob',
  'content',
  'payload',
  'NUXT_SESSION_PASSWORD',
  'SESSION_PASSWORD',
  'NUXT_TOKEN_VAULT_KEY',
  'TOKEN_VAULT_KEY',
  'NUXT_TDF_VAULT_KEY',
  'TDF_VAULT_KEY',
];

export const redactor = createRedactor({ extraKeys: EXTRA_KEYS });

export const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  ...BASE_SENSITIVE_KEYS,
  ...EXTRA_KEYS.map((key) => key.toLowerCase().replace(/[_-]/g, '')),
]);

export const isSensitiveKey = redactor.isSensitiveKey;
export const scrub = redactor.scrub;
export const redact = redactor.redact;
