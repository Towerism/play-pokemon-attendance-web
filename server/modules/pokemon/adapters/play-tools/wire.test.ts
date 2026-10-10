import { describe, expect, it } from 'vitest';
import { AttendancePage, BulkRecordRequestItem, OpErrorResponse, PlaySessionsPage, bulkRequestBody } from './wire';
import { opPaths } from './constants';

describe('bulkRequestBody', () => {
  it('produces exactly the payload the CLI and play-tools send', () => {
    const body = bulkRequestBody(['0012345']);
    expect(body).toEqual([{ participant: { player_id: '0012345' }, role: null, player: true, origin: 'roster', updated: '' }]);
    expect(BulkRecordRequestItem.safeParse(body[0]).success).toBe(true);
  });
});

const page = <T>(results: T[]) => ({ count: results.length, next: null, previous: null, results });

const record = (overrides: Record<string, unknown> = {}) => ({
  guid: 'rec-1',
  role: null,
  player: true,
  origin: 'roster',
  updated: '2026-10-07T01:02:03.194881Z',
  participant: { guid: 'p-1', player_id: '0012345', display_first_name: 'A', display_last_name: 'B', user: { guid: 'u-1' } },
  ...overrides,
});

describe('AttendancePage', () => {
  it('maps the record guid to recordId and keeps leading zeros in player ids', () => {
    const parsed = AttendancePage.parse(page([record()]));
    expect(parsed.items[0]).toMatchObject({ recordId: 'rec-1', participant: { player_id: '0012345' } });
  });

  it('normalises numeric player ids to strings', () => {
    const parsed = AttendancePage.parse(page([record({ participant: { guid: 'p', player_id: 42, display_first_name: null, display_last_name: null } })]));
    expect(parsed.items[0]?.participant.player_id).toBe('42');
  });

  it('rejects a non-DRF envelope and a record without guid', () => {
    expect(AttendancePage.safeParse({ data: [record()] }).success).toBe(false);
    expect(AttendancePage.safeParse(page([record({ guid: undefined })])).success).toBe(false);
  });
});

describe('PlaySessionsPage', () => {
  const session = {
    guid: 's-1',
    type: 'open_play',
    status: 'complete',
    start_date: '2026-10-06T23:00:00Z',
    end_date: '2026-10-07T02:00:00Z',
    final_modifiable_datetime: '2026-10-13T23:00:00Z',
    products: ['tcg'],
    attributes: [],
    schedule: null,
  };

  it('parses the verified session shape', () => {
    expect(PlaySessionsPage.parse(page([session])).items[0]?.guid).toBe('s-1');
  });

  it.each(['scheduled', 'completed'])('rejects status %j, which the API itself rejects', (status) => {
    expect(PlaySessionsPage.safeParse(page([{ ...session, status }])).success).toBe(false);
  });
});

describe('OpErrorResponse', () => {
  it('parses the verified unauthenticated 401 body', () => {
    const body = {
      code: 'op.generic.unauthorized',
      message: 'Request is not authenticated for the request.',
      errors: { header: { Authorization: [{ code: 'op.value.required', message: 'required' }] } },
    };
    expect(OpErrorResponse.parse(body).errors?.header?.Authorization?.[0]?.code).toBe('op.value.required');
  });

  it('parses the verified _bulk duplicate 400, whose field key carries the batch index', () => {
    const body = {
      code: 'op.generic.bad_request',
      message: 'Invalid request.',
      errors: {
        body: {
          '0.participant.player_id': [
            {
              code: 'op.activity_record.cannot_duplicate_participant',
              message: 'The provided participant already exists in the requested activity and cannot be added again.',
            },
          ],
        },
      },
    };
    expect(OpErrorResponse.parse(body).errors?.body?.['0.participant.player_id']?.[0]?.code).toBe(
      'op.activity_record.cannot_duplicate_participant',
    );
  });
});

describe('opPaths', () => {
  it('builds the CLI-proven bulk path and encodes segments', () => {
    expect(opPaths.recordsBulk('g', 's')).toBe('core/activity_groups/g/play_sessions/s/records/_bulk/');
    expect(opPaths.record('g', 's', 'a/b')).toBe('core/activity_groups/g/play_sessions/s/records/a%2Fb/');
  });
});
