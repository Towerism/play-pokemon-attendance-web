import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  ActivitiesPage,
  FIXTURE_SCHEMAS,
  type FixtureKind,
  OpErrorResponse,
  StaffAssignResponse,
  TournamentDetails,
  TournamentRecordsPage,
  staffAssignBody,
} from './wire';

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

/**
 * Contract gate for M8: the S6 recordings (`__fixtures__/s6/NN.METHOD.path.json`,
 * holding `{ method, path, query, status, request, response }`).
 */
const s6Dir = join(dir, 's6');
const s6 = existsSync(s6Dir) ? readdirSync(s6Dir).filter((f) => f.endsWith('.json')) : [];

/** Which schema a recorded 2xx response must match, by method and path. */
function s6Schema(method: string, path: string): z.ZodType | null | undefined {
  if (method === 'GET' && /\/core\/activities$/.test(path)) return ActivitiesPage;
  if (method === 'GET' && /\/core\/tournament\/[^/]+$/.test(path)) return TournamentDetails;
  if (method === 'GET' && /\/core\/tournaments\/[^/]+\/records$/.test(path)) return TournamentRecordsPage;
  if (method === 'POST' && /\/core\/tournaments\/[^/]+\/records$/.test(path)) return StaffAssignResponse;
  // PATCH and DELETE answer 204 with no body.
  if ((method === 'PATCH' || method === 'DELETE') && /\/core\/tournaments\/[^/]+\/records\/[^/]+$/.test(path)) return null;
  return undefined;
}

describe('play-tools staff wire contract (S6 recordings)', () => {
  it('has the S6 recordings', () => {
    expect(s6.length).toBeGreaterThanOrEqual(22);
  });

  for (const file of s6) {
    const rec = JSON.parse(readFileSync(join(s6Dir, file), 'utf8')) as {
      method: string;
      path: string;
      status: number;
      request: unknown;
      response: unknown;
    };
    const schema = s6Schema(rec.method, rec.path);

    it(`${file} is a call the adapter makes`, () => {
      expect(schema).not.toBeUndefined();
    });

    if (rec.status >= 200 && rec.status < 300) {
      it(`${file} (HTTP ${rec.status}) parses`, () => {
        if (schema === null) expect(rec.response).toBeNull();
        else expect(schema!.safeParse(rec.response).error?.issues ?? []).toEqual([]);
      });
    } else {
      it(`${file} (HTTP ${rec.status}) parses as OpErrorResponse`, () => {
        expect(OpErrorResponse.safeParse(rec.response).error?.issues ?? []).toEqual([]);
      });
    }

    if (rec.method === 'POST') {
      it(`${file}: the adapter builds the recorded request body`, () => {
        const req = rec.request as { role: string; participant: { player_id: string } };
        expect(staffAssignBody(req.participant.player_id, req.role)).toEqual(rec.request);
      });
    }
  }
});
