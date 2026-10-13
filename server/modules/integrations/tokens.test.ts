import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type OpenDatabase, migrateDatabase, openDatabase } from '../../db/client';
import { DEFAULT_LEAGUE_ID as L } from '../leagues';
import { IntegrationError } from './errors';
import { type IntegrationTokenService, createIntegrationTokenService } from './tokens';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const OTHER = 'other-league';

let database: OpenDatabase;
let tokens: IntegrationTokenService;
let now: Date;
let serial: number;
/** 32 fixed bytes per call, different each call, so secrets are predictable but distinct. */
const random = (size: number) => Buffer.alloc(size, ++serial);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const rows = () => database.sqlite.prepare('select * from integration_token order by id').all() as Record<string, unknown>[];

beforeEach(() => {
  database = openDatabase(':memory:');
  migrateDatabase(database.db, MIGRATIONS_DIR);
  database.sqlite.prepare(`insert into league (id, name) values (?, 'Elsewhere')`).run(OTHER);
  now = new Date('2026-10-13T12:00:00Z');
  serial = 0;
  tokens = createIntegrationTokenService({ db: database.db, now: () => now, randomBytes: random });
});
afterEach(() => database.close());

describe('create', () => {
  it('returns the secret once, stores only its SHA-256 and a hint, and lists the token without either secret or hash', () => {
    const { token, secret } = tokens.create(L, 'Tournament Genie', 'organizer');

    expect(secret).toMatch(/^ppa_int_[A-Za-z0-9_-]{43}$/);
    expect(token).toEqual({
      id: expect.any(Number),
      label: 'Tournament Genie',
      hint: `ppa_int_…${secret.slice(-4)}`,
      createdBy: 'organizer',
      createdAt: '2026-10-13T12:00:00.000Z',
      lastUsedAt: null,
    });
    const [row] = rows();
    expect(row).toMatchObject({ token_hash: sha256(secret), token_hint: token.hint, scope: 'integrations:read', league_id: L });
    expect(JSON.stringify(rows())).not.toContain(secret);
    expect(tokens.list(L)).toEqual([token]);
  });

  it('makes a different secret every time', () => {
    const a = tokens.create(L, 'A', 'organizer').secret;
    const b = tokens.create(L, 'B', 'organizer').secret;
    expect(a).not.toBe(b);
  });

  it('refuses an eleventh token in a league and keeps ten', () => {
    for (let i = 0; i < 10; i++) tokens.create(L, `T${i}`, 'organizer');
    expect(() => tokens.create(L, 'one too many', 'organizer')).toThrow(expect.objectContaining({ name: 'IntegrationError', code: 'token_limit' }));
    expect(tokens.list(L)).toHaveLength(10);
    expect(() => tokens.create(OTHER, 'another league', 'organizer')).not.toThrow();
  });
});

describe('list', () => {
  it("lists the league's tokens newest first, and never another league's", () => {
    const first = tokens.create(L, 'First', 'organizer').token;
    now = new Date('2026-10-13T13:00:00Z');
    const second = tokens.create(L, 'Second', 'organizer').token;
    tokens.create(OTHER, 'Elsewhere', 'organizer');
    expect(tokens.list(L).map((t) => t.id)).toEqual([second.id, first.id]);
  });
});

describe('authenticate', () => {
  it('names the token a live secret belongs to', () => {
    const { token, secret } = tokens.create(L, 'Genie', 'organizer');
    expect(tokens.authenticate(secret)).toEqual({ id: token.id, leagueId: L, label: 'Genie' });
  });

  it.each([
    ['nothing', undefined],
    ['an empty secret', ''],
    ['an unknown, well-formed secret', `ppa_int_${'A'.repeat(43)}`],
  ])('finds no token for %s', (_l, secret) => {
    tokens.create(L, 'Genie', 'organizer');
    expect(tokens.authenticate(secret)).toBeNull();
  });

  it('finds no token for a revoked secret', () => {
    const { token, secret } = tokens.create(L, 'Genie', 'organizer');
    tokens.revoke(L, token.id);
    expect(tokens.authenticate(secret)).toBeNull();
  });

  it('does not mark the token used', () => {
    const { secret } = tokens.create(L, 'Genie', 'organizer');
    tokens.authenticate(secret);
    expect(tokens.list(L)[0]!.lastUsedAt).toBeNull();
  });
});

describe('markUsed', () => {
  it('records when the token was last used', () => {
    const { token } = tokens.create(L, 'Genie', 'organizer');
    now = new Date('2026-10-14T09:30:00Z');
    tokens.markUsed(token.id);
    expect(tokens.list(L)[0]!.lastUsedAt).toBe('2026-10-14T09:30:00.000Z');
  });
});

describe('revoke', () => {
  it('deletes the token', () => {
    const { token } = tokens.create(L, 'Genie', 'organizer');
    tokens.revoke(L, token.id);
    expect(tokens.list(L)).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it.each([
    ['an unknown id', () => 999],
    ['an id already revoked', () => {
      const id = tokens.create(L, 'Genie', 'organizer').token.id;
      tokens.revoke(L, id);
      return id;
    }],
    ["another league's token", () => tokens.create(OTHER, 'Elsewhere', 'organizer').token.id],
  ])('answers not_found for %s and deletes nothing', (_l, idOf) => {
    const id = idOf();
    const before = rows().length;
    expect(() => tokens.revoke(L, id)).toThrow(IntegrationError);
    expect(() => tokens.revoke(L, id)).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(rows()).toHaveLength(before);
  });
});
