import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

// 32 symbols without the look-alikes 0/O and 1/I: 8 symbols ≈ 40 bits.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * One-time code printed to the container log while no account exists, so
 * only someone who can read the log can claim the install (ADR-0006).
 */
export function generateSetupCode(): string {
  const chars = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

/** Case-, space- and dash-insensitive, constant-time comparison. */
export function setupCodeMatches(expected: string, given: string): boolean {
  const a = normalize(expected);
  const b = normalize(given);
  if (!b) return false;
  return timingSafeEqual(digest(a), digest(b));
}

const normalize = (code: string) => code.replace(/[\s-]/g, '').toUpperCase();
const digest = (s: string) => createHash('sha256').update(s).digest();
