import { describe, expect, it } from 'vitest';
import { StartSubmissionBody, SubmissionIdParam, SubmissionListQuery } from './submission';

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
