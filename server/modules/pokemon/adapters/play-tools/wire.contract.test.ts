import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { EMPTY_DIVISION_INFO } from './constants';
import {
  ActivitiesPage,
  AddressBookList,
  CreateTournamentResponse,
  FIXTURE_SCHEMAS,
  type FixtureKind,
  OpErrorResponse,
  ProductsResponse,
  SeriesList,
  StaffAssignResponse,
  TournamentDetails,
  TournamentErrorResponse,
  TournamentRecordsPage,
  UploadsList,
  ValidateResponse,
  cancelTournamentBody,
  confirmResultsBody,
  createTournamentBody,
  editTournamentBody,
  staffAssignBody,
  validateResultsBody,
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

/**
 * Contract gate for M9: the S8 part 2 recordings (`__fixtures__/s8/`, same shape as S6). Every call is one the
 * adapter makes, its answer parses, and every recorded write body is what the adapter builds from the same inputs.
 */
const s8Dir = join(dir, 's8');
const s8 = existsSync(s8Dir) ? readdirSync(s8Dir).filter((f) => f.endsWith('.json')) : [];

/** The schema a recorded 2xx answer must match; null for an empty 204/202; undefined for a call the adapter never makes. */
function s8Schema(method: string, path: string): z.ZodType | null | undefined {
  if (method === 'GET' && /\/core\/activities$/.test(path)) return ActivitiesPage;
  if (method === 'GET' && /\/core\/tournament\/[^/]+$/.test(path)) return TournamentDetails;
  if (method === 'GET' && /\/core\/tournaments\/[^/]+\/records$/.test(path)) return TournamentRecordsPage;
  if (method === 'GET' && /\/core\/products$/.test(path)) return ProductsResponse;
  if (method === 'GET' && /\/core\/users\/[^/]+\/activity_groups\/[^/]+\/series\/$/.test(path)) return SeriesList;
  if (method === 'GET' && /\/core\/v2\/users\/[^/]+\/address_book$/.test(path)) return AddressBookList;
  if (method === 'GET' && /\/triumph\/tournament\/[^/]+\/uploads\/$/.test(path)) return UploadsList;
  if (method === 'POST' && /\/core\/tournament$/.test(path)) return CreateTournamentResponse;
  if (method === 'PATCH' && /\/core\/tournament\/[^/]+\/$/.test(path)) return null;
  if (method === 'POST' && /\/triumph\/tdf\/$/.test(path)) return ValidateResponse;
  if (method === 'PUT' && /\/triumph\/[^/]+\/confirm\/$/.test(path)) return null;
  return undefined;
}

/** Calls S8 made to learn something, which the adapter deliberately never makes (the play cycle; the TDF file read, #107). */
const NOT_ADAPTER_CALLS = [/\/api\/epoch\/cycle$/, /\/triumph\/tdf\/[^/]+$/];

describe('play-tools tournament lifecycle wire contract (S8 recordings)', () => {
  it('has the S8 part 2 recordings', () => {
    expect(s8.length).toBe(42);
  });

  for (const file of s8) {
    const rec = JSON.parse(readFileSync(join(s8Dir, file), 'utf8')) as {
      method: string;
      path: string;
      status: number;
      request: Record<string, unknown> | null;
      response: unknown;
    };
    if (NOT_ADAPTER_CALLS.some((p) => p.test(rec.path))) {
      it(`${file} (HTTP ${rec.status}) is not a call the adapter makes, and its error parses`, () => {
        expect(rec.status).toBeGreaterThanOrEqual(400);
        expect(TournamentErrorResponse.safeParse(rec.response).error?.issues ?? []).toEqual([]);
      });
      continue;
    }
    const schema = s8Schema(rec.method, rec.path);

    it(`${file} is a call the adapter makes`, () => {
      expect(schema).not.toBeUndefined();
    });

    if (rec.status >= 200 && rec.status < 300) {
      it(`${file} (HTTP ${rec.status}) parses`, () => {
        if (schema === null) expect(rec.response).toBeNull();
        else expect(schema!.safeParse(rec.response).error?.issues ?? []).toEqual([]);
      });
    } else {
      it(`${file} (HTTP ${rec.status}) parses as the tournament error envelope`, () => {
        expect(TournamentErrorResponse.safeParse(rec.response).error?.issues ?? []).toEqual([]);
      });
    }

    if (rec.method === 'POST' && /\/core\/tournament$/.test(rec.path)) {
      it(`${file}: the adapter builds the recorded create body`, () => {
        const r = rec.request as Record<string, never> & { contact_information: { email: string; phone: string } };
        const body = createTournamentBody(
          {
            groupId: r.activity_group_id,
            name: r.name,
            product: r.product,
            category: r.category,
            seriesId: r.series_guid,
            venueId: r.address_id,
            startsAt: new Date(r.start_date_v2),
            contact: r.contact_information,
          },
          r.organizer_id,
        );
        // Recording 15 is the refused `activity_division_info: null` attempt; the adapter always sends the empty divisions.
        expect(body).toEqual({ ...rec.request, activity_division_info: EMPTY_DIVISION_INFO });
      });
    }
    if (rec.method === 'PATCH') {
      it(`${file}: the adapter builds the recorded PATCH body`, () => {
        const r = rec.request as Record<string, string>;
        if ('application_state' in r) expect(cancelTournamentBody()).toEqual(r);
        else {
          const changes = { ...('details' in r ? { details: r.details } : {}), ...('start_date_v2' in r ? { startsAt: new Date(r.start_date_v2!) } : {}) };
          expect(editTournamentBody(changes)).toEqual(r);
        }
      });
    }
    if (rec.method === 'PUT') {
      it(`${file}: the adapter builds the recorded confirm body`, () => {
        expect(confirmResultsBody((rec.request as { tournament_id: string }).tournament_id)).toEqual(rec.request);
      });
    }
    if (rec.method === 'POST' && /\/triumph\/tdf\/$/.test(rec.path)) {
      it(`${file}: the adapter builds the recorded validate body (the sanitizer replaced the payload)`, () => {
        const r = rec.request as { tournament_id: string };
        expect({ ...validateResultsBody(r.tournament_id, '<tdf/>'), payload: '<redacted>' }).toEqual({ ...rec.request, payload: '<redacted>' });
      });
    }
  }
});
