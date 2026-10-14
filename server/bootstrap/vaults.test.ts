import { randomBytes } from 'node:crypto';
import { VaultError } from '@towerism/selfhost-kit';
import { describeVaultContract } from '@towerism/selfhost-kit/testing';
import { describe, expect, it } from 'vitest';
import { tdfVault, tokenCipher, tokenVault } from './vaults';

const key = () => randomBytes(32).toString('base64');

// The kit's contract, against the vaults exactly as attendance builds them (kit ADR-0008).
describeVaultContract('token', () => tokenCipher(key()));
describeVaultContract('TDF', () => tdfVault(key()));

describe("attendance's vaults", () => {
  it('the token vault round-trips a refresh token, bound to its row', () => {
    const vault = tokenVault(key());
    const blob = vault.encrypt('ory_rt_example-refresh-token', 'pokemon_connection:1');
    expect(vault.decrypt(blob, 'pokemon_connection:1')).toBe('ory_rt_example-refresh-token');
    expect(() => vault.decrypt(blob, 'pokemon_connection:2')).toThrow(VaultError);
  });

  it('the token vault is the token cipher with UTF-8 strings over it', () => {
    const k = key();
    const blob = tokenVault(k).encrypt('Pokémon 🃏', 'pokemon_connection:1');
    expect(tokenCipher(k).open(blob, 'pokemon_connection:1').toString('utf8')).toBe('Pokémon 🃏');
  });

  it('each vault names itself in its messages', () => {
    const bad = randomBytes(16).toString('base64');
    expect(() => tokenCipher(bad)).toThrow('The token vault key must be 32 bytes, base64-encoded.');
    expect(() => tokenVault(bad)).toThrow('The token vault key must be 32 bytes, base64-encoded.');
    expect(() => tdfVault(bad)).toThrow('The TDF vault key must be 32 bytes, base64-encoded.');
  });

  it('every vault refuses an empty AAD, so a row is always bound', () => {
    const k = key();
    const token = tokenVault(k);
    const cipher = tokenCipher(k);
    const tdf = tdfVault(k);
    expect(() => token.encrypt('ory_rt_x', '')).toThrow(VaultError);
    expect(() => token.decrypt(token.encrypt('ory_rt_x', 'a'), '')).toThrow(VaultError);
    expect(() => cipher.seal(Buffer.from('x'), '')).toThrow(VaultError);
    expect(() => cipher.open(cipher.seal(Buffer.from('x'), 'a'), '')).toThrow(VaultError);
    expect(() => tdf.seal(Buffer.from('x'), '')).toThrow(VaultError);
    expect(() => tdf.open(tdf.seal(Buffer.from('x'), 'a'), '')).toThrow(VaultError);
  });
});
