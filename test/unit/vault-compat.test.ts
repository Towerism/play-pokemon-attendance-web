import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createVault } from '../../server/modules/vault/vault';
import { createTokenVault } from '../../server/modules/pokemon/vault/vault';
import { createVault as legacyCreateVault } from '../fixtures/vault-v1/legacy/vault/vault';
import { createTokenVault as legacyCreateTokenVault } from '../fixtures/vault-v1/legacy/pokemon/vault/vault';

/**
 * Install compatibility of the vault (kit ADR-0007, A4): blobs sealed by attendance before it took the vault from
 * the kit must keep opening, and blobs sealed now must open with that older code (a rollback). The legacy oracle in
 * test/fixtures/vault-v1/legacy is a byte-for-byte copy of the two vault files at the pre-migration commit, pinned
 * below by their git blob ids; the corpus was sealed by it (test/fixtures/vault-v1/generate.ts).
 */

const FIXTURES = new URL('../fixtures/vault-v1/', import.meta.url);

/** `git rev-parse 4fb84ef:<path>`: the pre-migration vault files. Literal on purpose: never regenerate these. */
const LEGACY_BLOB_IDS = {
  'server/modules/vault/vault.ts': '5750a4c3016b791bbccec4240bacca150f3b4d57',
  'server/modules/pokemon/vault/vault.ts': 'bfb21549347391b89ee42eacc1496b9965ef781c',
};
const ORACLE_FILES = {
  'server/modules/vault/vault.ts': 'legacy/vault/vault.ts',
  'server/modules/pokemon/vault/vault.ts': 'legacy/pokemon/vault/vault.ts',
};

/** The vaults as attendance builds them: the code under test. */
const underTest = {
  tokenString: (key: string) => createTokenVault(key),
  tokenBytes: (key: string) => createVault(key, 'token'),
  tdf: (key: string) => createVault(key, 'tdf'),
};

const legacy = {
  tokenString: (key: string) => legacyCreateTokenVault(key),
  tokenBytes: (key: string) => legacyCreateVault(key, 'token'),
  tdf: (key: string) => legacyCreateVault(key, 'tdf'),
};

interface CorpusEntry {
  name: string;
  vault: 'token' | 'TDF';
  /** `string`: sealed with the token vault's `encrypt` (UTF-8); `bytes`: with the cipher's `seal`. */
  api: 'string' | 'bytes';
  key: string;
  aad: string;
  plaintextBase64?: string;
  plaintextSha256: string;
  blobBase64?: string;
  blobFile?: string;
}

interface Corpus {
  generatedFrom: string;
  legacyBlobIds: Record<string, string>;
  entries: CorpusEntry[];
}

const corpus = JSON.parse(readFileSync(new URL('corpus.json', FIXTURES), 'utf8')) as Corpus;
const blobOf = (e: CorpusEntry) =>
  e.blobFile ? readFileSync(new URL(e.blobFile, FIXTURES)) : Buffer.from(e.blobBase64!, 'base64');
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const gitBlobId = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const nonEmpty = corpus.entries.filter((e) => e.plaintextSha256 !== sha256(Buffer.alloc(0)));
const empty = corpus.entries.filter((e) => !nonEmpty.includes(e));

type Vaults = typeof underTest;

/** Opens with the API the entry was sealed with, returning the plaintext bytes. */
function open(vaults: Vaults, e: CorpusEntry, blob: Buffer, aad = e.aad): Buffer {
  if (e.api === 'string') return Buffer.from(vaults.tokenString(e.key).decrypt(blob, aad), 'utf8');
  return (e.vault === 'token' ? vaults.tokenBytes(e.key) : vaults.tdf(e.key)).open(blob, aad);
}

function seal(vaults: Vaults, e: CorpusEntry, plaintext: Buffer): Buffer {
  if (e.api === 'string') return vaults.tokenString(e.key).encrypt(plaintext.toString('utf8'), e.aad);
  return (e.vault === 'token' ? vaults.tokenBytes(e.key) : vaults.tdf(e.key)).seal(plaintext, e.aad);
}

/** Another AAD of the same shape: the next connection id, another league, another file hash. */
function otherAad(aad: string): string {
  const connection = /^pokemon_connection:(\d+)$/.exec(aad);
  if (connection) return `pokemon_connection:${Number(connection[1]) + 1}`;
  const file = /^tdf_file:([^:]+):([0-9a-f]{64})$/.exec(aad);
  if (file) return `tdf_file:${file[1]}:${file[2]!.slice(0, 63)}${file[2]!.endsWith('0') ? '1' : '0'}`;
  if (aad === 'default') return 'other-league';
  throw new Error(`no other AAD for the shape of ${aad}`);
}

const plaintextOf = (e: CorpusEntry) =>
  e.plaintextBase64 === undefined ? randomBytes(2 * 1024 * 1024) : Buffer.from(e.plaintextBase64, 'base64');

describe('the legacy oracle is the pre-migration vault code', () => {
  it.each(Object.entries(ORACLE_FILES))('%s is byte-for-byte the pre-migration file', (path, copy) => {
    expect(gitBlobId(readFileSync(new URL(copy, FIXTURES)))).toBe(LEGACY_BLOB_IDS[path as keyof typeof LEGACY_BLOB_IDS]);
  });

  it('sealed the corpus', () => {
    expect(corpus.legacyBlobIds).toEqual(LEGACY_BLOB_IDS);
    expect(corpus.generatedFrom).toBe('4fb84effa638de011efed1eee62a77646367364f');
  });
});

describe('the corpus covers every AAD shape and plaintext kind', () => {
  it('has each AAD shape, empty, binary and 2 MiB plaintexts, for both vaults', () => {
    const shapes = new Set(corpus.entries.map((e) => `${e.vault}:${e.aad.replace(/\d+$|[0-9a-f]{64}$/, '#')}`));
    expect(shapes).toEqual(
      new Set(['token:pokemon_connection:#', 'token:default', 'TDF:tdf_file:default:#', 'TDF:tdf_file:other-league:#']),
    );
    expect(empty.map((e) => e.vault).sort()).toEqual(['TDF', 'token']);
    expect(corpus.entries.filter((e) => e.blobFile).map((e) => e.vault)).toEqual(['TDF']);
    expect(corpus.entries.filter((e) => e.name.includes('every byte value')).map((e) => e.vault).sort()).toEqual(['TDF', 'token']);
  });
});

describe('blobs sealed by the pre-migration code open with the code under test', () => {
  it.each(nonEmpty.map((e) => [e.name, e] as const))('%s', (_name, e) => {
    const plaintext = open(underTest, e, blobOf(e));
    expect(sha256(plaintext)).toBe(e.plaintextSha256);
    if (e.plaintextBase64 !== undefined) expect(plaintext.toString('base64')).toBe(e.plaintextBase64);
  });

  it.each(nonEmpty.map((e) => [e.name, e] as const))('%s is refused under another AAD of its shape', (_name, e) => {
    expect(() => open(underTest, e, blobOf(e), otherAad(e.aad))).toThrow(/could not be decrypted/);
  });

  it("opens attendance's golden blob (token vault, all-7s key, AAD default)", () => {
    const golden = 'AbfWiVVN/vKVhQd5fhK97rvVWexlQ/aJWBkQm0/HHmiMFV/pGXag4c/7v87dxW5W8JFbEplJMVk=';
    const vault = underTest.tokenString(Buffer.alloc(32, 7).toString('base64'));
    expect(vault.decrypt(Buffer.from(golden, 'base64'), 'default')).toBe('ory_rt_golden-refresh-token');
  });
});

describe('blobs sealed by the code under test open with the pre-migration code (rollback)', () => {
  it.each(nonEmpty.map((e) => [e.name, e] as const))('%s', (_name, e) => {
    const plaintext = plaintextOf(e);
    expect(open(legacy, e, seal(underTest, e, plaintext)).equals(plaintext)).toBe(true);
  });
});

describe('an empty plaintext (attendance never seals one)', () => {
  it('the pre-migration code refuses even its own header-only blob', () => {
    const key = randomBytes(32).toString('base64');
    const blob = legacy.tdf(key).seal(Buffer.alloc(0), 'tdf_file:default:x');
    expect(blob.length).toBe(29);
    expect(() => legacy.tdf(key).open(blob, 'tdf_file:default:x')).toThrow(
      'The stored TDF data is not in a format this version understands.',
    );
  });

  it.each(empty.map((e) => [e.name, e] as const))('the code under test opens %s from the corpus as empty', (_name, e) => {
    expect(open(underTest, e, blobOf(e)).length).toBe(0);
  });

  it.each(empty.map((e) => [e.name, e] as const))(
    'the pre-migration code refuses %s sealed by the code under test (a rollback never meets one)',
    (_name, e) => {
      expect(() => open(legacy, e, seal(underTest, e, Buffer.alloc(0)))).toThrow(/not in a format this version understands/);
    },
  );
});

describe('operator-facing messages keep their wording', () => {
  const vaults = [
    ['token', underTest.tokenBytes],
    ['TDF', underTest.tdf],
  ] as const;
  const AAD = 'pokemon_connection:42';
  const key = randomBytes(32).toString('base64');

  it.each(vaults)('the %s vault refuses a key that is not 32 bytes', (label, make) => {
    const bad = randomBytes(16).toString('base64');
    expect(() => make(bad)).toThrow(`The ${label} vault key must be 32 bytes, base64-encoded.`);
  });

  it('the token string vault refuses a key that is not 32 bytes', () => {
    expect(() => underTest.tokenString(randomBytes(16).toString('base64'))).toThrow(
      'The token vault key must be 32 bytes, base64-encoded.',
    );
  });

  it.each(vaults)('the %s vault names wrong-key, tampered and malformed blobs, never the key or AAD', (label, make) => {
    const blob = make(key).seal(Buffer.from('secret'), AAD);
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1]! ^= 0x01;
    const cases: [Buffer, string, string][] = [
      [blob, randomBytes(32).toString('base64'), `The stored ${label} data could not be decrypted (wrong key or tampered data).`],
      [tampered, key, `The stored ${label} data could not be decrypted (wrong key or tampered data).`],
      [Buffer.concat([Buffer.from([9]), blob.subarray(1)]), key, `The stored ${label} data is not in a format this version understands.`],
      [Buffer.alloc(5), key, `The stored ${label} data is not in a format this version understands.`],
    ];
    for (const [input, withKey, message] of cases) {
      let thrown: unknown;
      try {
        make(withKey).open(input, AAD);
      } catch (err) {
        thrown = err;
      }
      expect((thrown as Error).message).toBe(message);
      expect((thrown as Error).message).not.toContain(withKey);
      expect((thrown as Error).message).not.toContain(AAD);
    }
  });
});
