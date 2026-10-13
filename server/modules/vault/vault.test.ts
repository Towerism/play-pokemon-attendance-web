import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { VaultError, createVault } from './vault';

const key = () => randomBytes(32).toString('base64');
const K = key();
const SECRET = Buffer.from('<player userid="1"><birthdate>01/02/2012</birthdate></player>');

describe('vault (AES-256-GCM, ADR-0003 / ADR-0012)', () => {
  it('round-trips binary plaintext for the same AAD', () => {
    const vault = createVault(key(), 'tdf');
    const binary = Buffer.from([0, 255, 1, 254, ...SECRET]);
    expect(vault.open(vault.seal(binary, 'tdf_file:default:abc'), 'tdf_file:default:abc').equals(binary)).toBe(true);
  });

  it('writes version 1, a 12-byte IV and a 16-byte tag ahead of the ciphertext', () => {
    const blob = createVault(key(), 'tdf').seal(SECRET, 'aad');
    expect(blob[0]).toBe(1);
    expect(blob.length).toBe(1 + 12 + 16 + SECRET.length);
  });

  it('uses a fresh IV every time and never holds the plaintext', () => {
    const vault = createVault(key(), 'tdf');
    const a = vault.seal(SECRET, 'aad');
    expect(a.equals(vault.seal(SECRET, 'aad'))).toBe(false);
    expect(a.toString('latin1')).not.toContain('birthdate');
  });

  it.each([
    ['another AAD (a blob copied to another row)', (blob: Buffer) => createVault(K, 'tdf').open(blob, 'tdf_file:default:other')],
    ['another key', (blob: Buffer) => createVault(key(), 'tdf').open(blob, 'aad')],
    [
      'a flipped byte',
      (blob: Buffer) => {
        blob[blob.length - 1]! ^= 0x01;
        return createVault(K, 'tdf').open(blob, 'aad');
      },
    ],
    ['an unknown version', (blob: Buffer) => createVault(K, 'tdf').open(Buffer.concat([Buffer.from([9]), blob.subarray(1)]), 'aad')],
    ['too short', () => createVault(K, 'tdf').open(Buffer.alloc(5), 'aad')],
  ])('refuses %s', (_label, open) => {
    expect(() => open(createVault(K, 'tdf').seal(SECRET, 'aad'))).toThrow(VaultError);
  });

  it('names its purpose in errors, never the key', () => {
    expect(() => createVault('!'.repeat(44), 'tdf')).toThrow(/TDF vault key must be 32 bytes/);
    expect(() => createVault(randomBytes(16).toString('base64'), 'token')).toThrow(/token vault key must be 32 bytes/);
    expect(() => createVault(K, 'tdf').open(Buffer.alloc(5), 'aad')).toThrow(/TDF/);
  });
});
