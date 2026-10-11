import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TokenVaultError, createTokenVault } from './vault';

const key = () => randomBytes(32).toString('base64');
const SECRET = 'ory_rt_example-refresh-token';

describe('token vault (AES-256-GCM, ADR-0003)', () => {
  it('round-trips a secret for the same league', () => {
    const vault = createTokenVault(key());
    expect(vault.decrypt(vault.encrypt(SECRET, 'default'), 'default')).toBe(SECRET);
  });

  it('never stores the plaintext and uses a fresh IV every time', () => {
    const vault = createTokenVault(key());
    const a = vault.encrypt(SECRET, 'default');
    const b = vault.encrypt(SECRET, 'default');

    expect(a.toString('latin1')).not.toContain(SECRET);
    expect(a.equals(b)).toBe(false);
  });

  it('refuses ciphertext that was tampered with', () => {
    const vault = createTokenVault(key());
    const box = vault.encrypt(SECRET, 'default');
    box[box.length - 1]! ^= 0x01;

    expect(() => vault.decrypt(box, 'default')).toThrow(TokenVaultError);
  });

  it('refuses ciphertext made with another key (e.g. a lost or replaced key file)', () => {
    const box = createTokenVault(key()).encrypt(SECRET, 'default');
    expect(() => createTokenVault(key()).decrypt(box, 'default')).toThrow(TokenVaultError);
  });

  it('binds the ciphertext to its league, so a row copied to another league does not decrypt', () => {
    const vault = createTokenVault(key());
    expect(() => vault.decrypt(vault.encrypt(SECRET, 'default'), 'other')).toThrow(TokenVaultError);
  });

  it.each([
    ['too short', Buffer.alloc(5)],
    ['an unknown format version', Buffer.concat([Buffer.from([9]), randomBytes(40)])],
  ])('refuses a blob that is %s', (_label, blob) => {
    expect(() => createTokenVault(key()).decrypt(blob, 'default')).toThrow(TokenVaultError);
  });

  it.each([
    ['empty', ''],
    ['16 bytes', randomBytes(16).toString('base64')],
    ['not base64', '!'.repeat(44)],
  ])('refuses a key that is %s, without echoing it', (_label, bad) => {
    expect(() => createTokenVault(bad)).toThrow(/32 bytes/);
    if (bad) expect(() => createTokenVault(bad)).not.toThrow(bad);
  });
});
