import { describe, expect, it } from 'vitest';
import { AttendancePage, BulkRecordRequestItem, PlaySessionsPage, bulkRequestBody } from './wire';
import { opPaths } from './constants';

describe('bulkRequestBody', () => {
  it('produces exactly the payload the CLI and play-tools send', () => {
    const body = bulkRequestBody(['0012345']);
    expect(body).toEqual([{ participant: { player_id: '0012345' }, role: null, player: true, origin: 'roster', updated: '' }]);
    expect(BulkRecordRequestItem.safeParse(body[0]).success).toBe(true);
  });
});

describe('AttendancePage', () => {
  it('reads items from `results` and normalises the record id and numeric player ids', () => {
    const page = AttendancePage.parse({ results: [{ id: 'r-1', participant: { player_id: 123 } }], next: null });
    expect(page.items).toEqual([expect.objectContaining({ recordId: 'r-1', participant: { player_id: '123' } })]);
  });

  it('falls back to `data` and the alternative id fields the CLI probed', () => {
    const page = AttendancePage.parse({ data: [{ guid: 'g-1', participant: { player_id: '007' } }] });
    expect(page.items[0]?.recordId).toBe('g-1');
    expect(page.items[0]?.participant.player_id).toBe('007');
  });

  it('rejects a page with no item list and a record with no id', () => {
    expect(AttendancePage.safeParse({ count: 0 }).success).toBe(false);
    expect(AttendancePage.safeParse({ results: [{ participant: { player_id: '1' } }] }).success).toBe(false);
  });
});

describe('PlaySessionsPage', () => {
  it('requires some start field', () => {
    expect(PlaySessionsPage.safeParse({ results: [{ id: 's', start_datetime: '2026-10-14T23:00:00Z' }] }).success).toBe(true);
    expect(PlaySessionsPage.safeParse({ results: [{ id: 's' }] }).success).toBe(false);
  });
});

describe('opPaths', () => {
  it('builds the CLI-proven bulk path and encodes segments', () => {
    expect(opPaths.recordsBulk('g', 's')).toBe('core/activity_groups/g/play_sessions/s/records/_bulk/');
    expect(opPaths.record('g', 's', 'a/b')).toBe('core/activity_groups/g/play_sessions/s/records/a%2Fb/');
  });
});
