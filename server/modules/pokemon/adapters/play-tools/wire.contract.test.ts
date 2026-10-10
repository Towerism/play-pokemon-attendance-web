import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURE_SCHEMAS, type FixtureKind, OpErrorResponse } from './wire';

/**
 * Contract gate for M0. The play-tools adapter contract is "frozen" when this
 * suite runs against sanitized real fixtures for every FixtureKind (no todos)
 * and `wire.ts` has no TODO(Sx) markers left.
 */
const dir = join(import.meta.dirname, '__fixtures__');
const fixtures = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];

describe('play-tools wire contract (recorded fixtures)', () => {
  for (const kind of Object.keys(FIXTURE_SCHEMAS) as FixtureKind[]) {
    const ofKind = fixtures.filter((f) => f.startsWith(`${kind}.`));
    if (ofKind.length === 0) {
      it.todo(`${kind}: record with the M0 spikes (see spikes/README.md)`);
      continue;
    }
    for (const file of ofKind) {
      const { status, body } = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { status: number; body: unknown };
      if (status >= 200 && status < 300) {
        it(`${file} parses as ${kind}`, () => {
          const parsed = FIXTURE_SCHEMAS[kind].safeParse(body);
          expect(parsed.error?.issues ?? []).toEqual([]);
        });
      } else if (typeof body === 'object' && body !== null) {
        it(`${file} (HTTP ${status}) parses as OpErrorResponse`, () => {
          expect(OpErrorResponse.safeParse(body).error?.issues ?? []).toEqual([]);
        });
      }
    }
  }
});
