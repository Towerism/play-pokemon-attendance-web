import { describe, expect, it } from 'vitest';
import { ResultsConfirmBody, ResultsOrganizerBody, ResultsParams, ResultsPreviewBody, ResultsRemoveStaffBody, ResultsUploadParams } from './results';

const FP = 'a'.repeat(64);
const GUID = '00000000-0000-4000-8000-0000000000c1';

describe('ResultsParams', () => {
  it('takes a calendar date and a guid, lower-cased', () => {
    expect(ResultsParams.parse({ date: '2026-10-14', tournamentId: GUID.toUpperCase() })).toEqual({ date: '2026-10-14', tournamentId: GUID });
  });

  it.each([
    [{ date: '2026-02-30', tournamentId: GUID }],
    [{ date: '2026-10-14', tournamentId: 'not-a-guid' }],
    [{ date: '2026-10-14', tournamentId: '12' }],
  ])('refuses %j', (params) => {
    expect(ResultsParams.safeParse(params).success).toBe(false);
  });

  it('takes an upload id of digits only', () => {
    expect(ResultsUploadParams.parse({ date: '2026-10-14', tournamentId: GUID, uploadId: '42' })).toMatchObject({ uploadId: 42 });
    for (const uploadId of ['0', '-1', '1.5', 'x', '12345678901234567']) {
      expect(ResultsUploadParams.safeParse({ date: '2026-10-14', tournamentId: GUID, uploadId }).success).toBe(false);
    }
  });
});

describe('ResultsPreviewBody', () => {
  it('is the TDF upload body, with no other field', () => {
    expect(ResultsPreviewBody.parse({ filename: 'a.tdf', content: '<x/>' })).toEqual({ filename: 'a.tdf', content: '<x/>' });
    expect(ResultsPreviewBody.safeParse({ filename: 'a.tdf', content: '<x/>', extra: 1 }).success).toBe(false);
    expect(ResultsPreviewBody.safeParse({ filename: 'a.tdf', content: '' }).success).toBe(false);
  });
});

describe('ResultsConfirmBody', () => {
  it('takes a boolean and a lower-case SHA-256 hex fingerprint', () => {
    expect(ResultsConfirmBody.parse({ importAttendance: true, acknowledgedWarnings: FP })).toEqual({ importAttendance: true, acknowledgedWarnings: FP });
  });

  it.each([
    ['no fingerprint', { importAttendance: true }],
    ['upper case', { importAttendance: true, acknowledgedWarnings: 'A'.repeat(64) }],
    ['63 characters', { importAttendance: true, acknowledgedWarnings: 'a'.repeat(63) }],
    ['65 characters', { importAttendance: true, acknowledgedWarnings: 'a'.repeat(65) }],
    ['not hex', { importAttendance: true, acknowledgedWarnings: 'g'.repeat(64) }],
    ['importAttendance missing', { acknowledgedWarnings: FP }],
    ['importAttendance a string', { importAttendance: 'true', acknowledgedWarnings: FP }],
    ['an unknown field', { importAttendance: true, acknowledgedWarnings: FP, force: true }],
  ])('refuses %s', (_label, body) => {
    expect(ResultsConfirmBody.safeParse(body).success).toBe(false);
  });
});

describe('ResultsRemoveStaffBody', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => String(1000 + i));

  it('takes 1 to 50 distinct player ids, leading zeros kept', () => {
    expect(ResultsRemoveStaffBody.parse({ playerIds: ['0012'] })).toEqual({ playerIds: ['0012'] });
    expect(ResultsRemoveStaffBody.parse({ playerIds: ids(50) }).playerIds).toHaveLength(50);
  });

  it.each([
    ['none', { playerIds: [] }],
    ['51', { playerIds: ids(51) }],
    ['a duplicate', { playerIds: ['1000', '1000'] }],
    ['13 digits', { playerIds: ['1234567890123'] }],
    ['letters', { playerIds: ['12a'] }],
    ['a number', { playerIds: [12] }],
    ['an unknown field', { playerIds: ['1'], all: true }],
  ])('refuses %s', (_label, body) => {
    expect(ResultsRemoveStaffBody.safeParse(body).success).toBe(false);
  });
});

describe('ResultsOrganizerBody', () => {
  it('trims the full name and keeps punctuation', () => {
    expect(ResultsOrganizerBody.parse({ fullName: "  Pat O'Neil & <Co>  " })).toEqual({ fullName: "Pat O'Neil & <Co>" });
    expect(ResultsOrganizerBody.parse({ fullName: 'a'.repeat(100) }).fullName).toHaveLength(100);
  });

  it.each([
    ['empty', { fullName: '' }],
    ['only spaces', { fullName: '   ' }],
    ['101 characters', { fullName: 'a'.repeat(101) }],
    ['a control character', { fullName: 'Pat\u0000' }],
    ['a newline', { fullName: 'Pat\nOrganizer' }],
    ['null', { fullName: null }],
    ['an unknown field', { fullName: 'Pat', name: 'P' }],
  ])('refuses %s', (_label, body) => {
    expect(ResultsOrganizerBody.safeParse(body).success).toBe(false);
  });
});
