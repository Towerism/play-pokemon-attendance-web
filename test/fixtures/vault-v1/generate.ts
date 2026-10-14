/**
 * Generates corpus.json (+ tdf-2mib.bin): blobs sealed by the **pre-migration** vault code (the legacy oracle in
 * ./legacy, byte-for-byte the files at 4fb84ef), which test/unit/vault-compat.test.ts opens with the code under test.
 *
 *   pnpm exec tsx test/fixtures/vault-v1/generate.ts
 *
 * Every key and plaintext is random or synthetic. Run once; regenerating changes nothing the test relies on, but
 * the committed corpus is the record of what that code produced.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createTokenVault } from './legacy/pokemon/vault/vault';
import { createVault } from './legacy/vault/vault';

const HERE = new URL('./', import.meta.url);
const PRE_MIGRATION_COMMIT = '4fb84effa638de011efed1eee62a77646367364f';
const LEGACY_BLOB_IDS = {
  'server/modules/vault/vault.ts': '5750a4c3016b791bbccec4240bacca150f3b4d57',
  'server/modules/pokemon/vault/vault.ts': 'bfb21549347391b89ee42eacc1496b9965ef781c',
};
const ORACLE_FILES = {
  'server/modules/vault/vault.ts': 'legacy/vault/vault.ts',
  'server/modules/pokemon/vault/vault.ts': 'legacy/pokemon/vault/vault.ts',
};

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const gitBlobId = (b: Buffer) => createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');

for (const [path, copy] of Object.entries(ORACLE_FILES)) {
  const id = gitBlobId(readFileSync(new URL(copy, HERE)));
  if (id !== LEGACY_BLOB_IDS[path as keyof typeof LEGACY_BLOB_IDS]) throw new Error(`${copy} is not ${path} at ${PRE_MIGRATION_COMMIT}`);
}

const key = () => randomBytes(32).toString('base64');
const refreshToken = () => `ory_rt_${randomBytes(24).toString('base64url')}`;
const everyByte = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
const tdf = (league: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<tournament type="2" stage="5" version="1.7" gametype="TRADING_CARD_GAME" mode="LEAGUECHALLENGE">` +
  `<data><name>Synthetic ${league} League Challenge</name><id>26-01-000001</id><city>Testville</city>` +
  `<startdate>01/02/2026</startdate></data><players><player userid="1000001"><firstname>Ash</firstname>` +
  `<lastname>Example</lastname></player></players></tournament>\n`;

type Spec = { name: string; vault: 'token' | 'TDF'; api: 'string' | 'bytes'; aad: string | ((plaintext: Buffer) => string); plaintext: Buffer; blobFile?: string };
const tdfAad = (league: string) => (plaintext: Buffer) => `tdf_file:${league}:${sha256(plaintext)}`;
const gzipped = (league: string) => gzipSync(Buffer.from(tdf(league), 'utf8'));

const specs: Spec[] = [
  { name: 'token: refresh token, pokemon_connection:1', vault: 'token', api: 'string', aad: 'pokemon_connection:1', plaintext: Buffer.from(refreshToken()) },
  { name: 'token: refresh token, pokemon_connection:2147483647', vault: 'token', api: 'string', aad: 'pokemon_connection:2147483647', plaintext: Buffer.from(refreshToken()) },
  { name: 'token: multi-byte UTF-8, pokemon_connection:7', vault: 'token', api: 'string', aad: 'pokemon_connection:7', plaintext: Buffer.from('Pokémon ポケモン 🃏 ory_rt_x') },
  { name: 'token: carried-over refresh token sealed with the league id (default)', vault: 'token', api: 'string', aad: 'default', plaintext: Buffer.from(refreshToken()) },
  { name: 'token: empty plaintext, pokemon_connection:3', vault: 'token', api: 'bytes', aad: 'pokemon_connection:3', plaintext: Buffer.alloc(0) },
  { name: 'token: every byte value, pokemon_connection:4', vault: 'token', api: 'bytes', aad: 'pokemon_connection:4', plaintext: everyByte },
  // The archive's AAD hashes the file's text before gzip; for the synthetic binary entries, the hash of the plaintext.
  { name: 'TDF: gzipped TDF, tdf_file:default', vault: 'TDF', api: 'bytes', aad: () => `tdf_file:default:${sha256(Buffer.from(tdf('default')))}`, plaintext: gzipped('default') },
  { name: 'TDF: gzipped TDF, tdf_file:other-league', vault: 'TDF', api: 'bytes', aad: () => `tdf_file:other-league:${sha256(Buffer.from(tdf('other-league')))}`, plaintext: gzipped('other-league') },
  { name: 'TDF: empty plaintext, tdf_file:default', vault: 'TDF', api: 'bytes', aad: tdfAad('default'), plaintext: Buffer.alloc(0) },
  { name: 'TDF: every byte value, tdf_file:default', vault: 'TDF', api: 'bytes', aad: tdfAad('default'), plaintext: everyByte },
  { name: 'TDF: 2 MiB random, tdf_file:default', vault: 'TDF', api: 'bytes', aad: tdfAad('default'), plaintext: randomBytes(2 * 1024 * 1024), blobFile: 'tdf-2mib.bin' },
];

const entries = specs.map((s) => {
  const k = key();
  const aad = typeof s.aad === 'string' ? s.aad : s.aad(s.plaintext);
  const blob =
    s.api === 'string'
      ? createTokenVault(k).encrypt(s.plaintext.toString('utf8'), aad)
      : createVault(k, s.vault === 'token' ? 'token' : 'tdf').seal(s.plaintext, aad);
  if (s.blobFile) writeFileSync(new URL(s.blobFile, HERE), blob);
  return {
    name: s.name,
    vault: s.vault,
    api: s.api,
    key: k,
    aad,
    ...(s.blobFile ? {} : { plaintextBase64: s.plaintext.toString('base64') }),
    plaintextSha256: sha256(s.plaintext),
    ...(s.blobFile ? { blobFile: s.blobFile } : { blobBase64: blob.toString('base64') }),
  };
});

writeFileSync(
  new URL('corpus.json', HERE),
  `${JSON.stringify({ generatedFrom: PRE_MIGRATION_COMMIT, generator: 'test/fixtures/vault-v1/generate.ts', legacyBlobIds: LEGACY_BLOB_IDS, entries }, null, 2)}\n`,
);
console.log(`Wrote ${entries.length} entries.`);
