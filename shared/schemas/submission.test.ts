import { describe, expect, it } from 'vitest';
import { ClearPreviewQuery, ClearSessionBody, StartSubmissionBody, SubmissionIdParam, SubmissionListQuery } from './submission';

describe('StartSubmissionBody', () => {
  it('takes the play session GUID the organizer confirmed', () => {
    expect(StartSubmissionBody.parse({ playSessionId: ' ps-1 ' })).toEqual({ playSessionId: 'ps-1' });
  });

  it.each([{}, { playSessionId: '' }, { playSessionId: 42 }, { playSessionId: 'x'.repeat(101) }])('rejects %j', (body) => {
    expect(StartSubmissionBody.safeParse(body).success).toBe(false);
  });
});

describe('SubmissionIdParam', () => {
  it('coerces a positive integer id from the path', () => {
    expect(SubmissionIdParam.parse({ id: '12' })).toEqual({ id: 12 });
  });

  it.each(['abc', '0', '-1', '1.5', '', '1e3'])('rejects %j', (id) => {
    expect(SubmissionIdParam.safeParse({ id }).success).toBe(false);
  });
});

describe('SubmissionListQuery', () => {
  it('takes an optional session date', () => {
    expect(SubmissionListQuery.parse({})).toEqual({});
    expect(SubmissionListQuery.parse({ date: '2026-10-13' })).toEqual({ date: '2026-10-13' });
  });

  it('rejects a date that is not a calendar date', () => {
    expect(SubmissionListQuery.safeParse({ date: '2026-02-30' }).success).toBe(false);
  });
});

describe('ClearSessionBody', () => {
  it('takes the play session and the typed date exactly as entered, so the server can compare it', () => {
    expect(ClearSessionBody.parse({ playSessionId: ' ps-1 ', confirmDate: '10/13/2026' })).toEqual({ playSessionId: 'ps-1', confirmDate: '10/13/2026' });
    expect(ClearSessionBody.parse({ playSessionId: 'ps-1', confirmDate: ' 2026-10-13' }).confirmDate).toBe(' 2026-10-13');
  });

  it.each([
    { confirmDate: '2026-10-13' },
    { playSessionId: 'ps-1' },
    { playSessionId: 'ps-1', confirmDate: 20261013 },
    { playSessionId: 'ps-1', confirmDate: 'x'.repeat(33) },
    { playSessionId: '', confirmDate: '2026-10-13' },
  ])('rejects %j', (body) => {
    expect(ClearSessionBody.safeParse(body).success).toBe(false);
  });
});

describe('ClearPreviewQuery', () => {
  it('needs the play session to preview', () => {
    expect(ClearPreviewQuery.parse({ playSessionId: 'ps-1' })).toEqual({ playSessionId: 'ps-1' });
    expect(ClearPreviewQuery.safeParse({}).success).toBe(false);
  });
});
