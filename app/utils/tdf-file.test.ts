import { describe, expect, it } from 'vitest';
import { TDF_MAX_BYTES } from '../../shared/tdf/limits';
import { readTdfFile, tdfCommitSummary, tdfDateWarning, tdfPreviewSummary } from './tdf-file';

const file = (text: string, name = 'cup.tdf') => new File([text], name);

describe('readTdfFile', () => {
  it('returns the file name and text for the server to parse', async () => {
    expect(await readTdfFile(file('<tournament/>'))).toEqual({ ok: true, value: { filename: 'cup.tdf', content: '<tournament/>' } });
  });

  it('refuses an oversized file before reading it', async () => {
    expect(await readTdfFile(file('x'.repeat(TDF_MAX_BYTES + 1)))).toEqual({ ok: false, error: 'cup.tdf is too large (max 2 MB).' });
  });

  it('refuses an empty file', async () => {
    expect(await readTdfFile(file(''))).toEqual({ ok: false, error: 'cup.tdf is empty.' });
  });
});

describe('tdfDateWarning', () => {
  it('is null when the tournament was on the session date', () => {
    expect(tdfDateWarning('2026-10-14', '2026-10-14')).toBeNull();
  });

  it('is null when the file has no readable date', () => {
    expect(tdfDateWarning(null, '2026-10-14')).toBeNull();
  });

  it('warns when the tournament was on another date', () => {
    expect(tdfDateWarning('2026-10-07', '2026-10-14')).toBe(
      'This tournament was held on 2026-10-07, but you are importing it into 2026-10-14.',
    );
  });
});

describe('tdfPreviewSummary', () => {
  const counts = { new: 0, known: 0, regulars: 0, listed: 0, invalid: 0, duplicates: 0 };

  it('lists the non-zero groups in a fixed order', () => {
    expect(tdfPreviewSummary({ ...counts, new: 3, known: 9, regulars: 6, listed: 1 })).toBe(
      '3 new · 9 known · 6 regulars · 1 already listed',
    );
  });

  it('uses the singular for one', () => {
    expect(tdfPreviewSummary({ ...counts, regulars: 1 })).toBe('1 regular');
  });

  it('mentions skipped rows', () => {
    expect(tdfPreviewSummary({ ...counts, new: 2, invalid: 1, duplicates: 2 })).toBe('2 new · 1 invalid row skipped · 2 duplicates skipped');
  });
});

describe('tdfCommitSummary', () => {
  it('says how many were added and how many were already there', () => {
    expect(tdfCommitSummary({ added: 3, alreadyListed: 1, regulars: 6, alreadyImported: false })).toBe(
      'Added 3 session players · 1 already listed · 6 regulars',
    );
  });

  it('says so when nothing new was added', () => {
    expect(tdfCommitSummary({ added: 0, alreadyListed: 2, regulars: 0, alreadyImported: false })).toBe(
      'No new session players · 2 already listed',
    );
  });

  it('says the file was already imported', () => {
    expect(tdfCommitSummary({ added: 0, alreadyListed: 0, regulars: 0, alreadyImported: true })).toBe(
      'This file was already imported for this date.',
    );
  });
});
