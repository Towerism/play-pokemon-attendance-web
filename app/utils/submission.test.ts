import { describe, expect, it } from 'vitest';
import { isSubmissionActive, progressPercent, submissionStatus, submissionSummary } from './submission';

const zero = { added: 0, alreadyPresent: 0, failed: 0, skipped: 0, unrequested: 0 };

describe('submissionSummary', () => {
  it('says what happened, leaving out the zeros', () => {
    expect(submissionSummary({ ...zero, added: 9, alreadyPresent: 18 })).toBe('9 added · 18 already in play-tools');
    expect(submissionSummary({ ...zero, added: 1, failed: 2, skipped: 3 })).toBe('1 added · 2 failed · 3 not sent');
  });

  it('mentions players play-tools has that are not on the list', () => {
    expect(submissionSummary({ ...zero, alreadyPresent: 1, unrequested: 2 })).toBe('1 already in play-tools · 2 more in play-tools only');
  });

  it('says so when there was nothing to do', () => {
    expect(submissionSummary(zero)).toBe('Nothing to send');
  });
});

describe('submissionStatus', () => {
  it.each([
    ['succeeded', 'Done', 'success'],
    ['partial', 'Partly done', 'warning'],
    ['failed', 'Failed', 'error'],
    ['interrupted', 'Interrupted', 'warning'],
    ['running', 'Sending…', 'info'],
    ['planned', 'Starting…', 'info'],
  ] as const)('labels %s', (status, label, color) => {
    expect(submissionStatus(status)).toEqual({ label, color });
  });
});

describe('isSubmissionActive', () => {
  it('is true only while the job can still change', () => {
    expect(['planned', 'running', 'succeeded', 'partial', 'failed', 'interrupted'].filter((s) => isSubmissionActive(s))).toEqual([
      'planned',
      'running',
    ]);
  });
});

describe('progressPercent', () => {
  it.each([
    [0, 4, 0],
    [1, 3, 33],
    [4, 4, 100],
    [0, 0, 100],
    [5, 4, 100],
  ])('%i of %i is %i%%', (done, total, pct) => {
    expect(progressPercent(done, total)).toBe(pct);
  });
});
