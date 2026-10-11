import { describe, expect, it } from 'vitest';
import type { SubmissionItemView } from '../../server/modules/submission/service';
import {
  historyLabel,
  isSubmissionActive,
  progressPercent,
  submissionStatus,
  submissionSummary,
  undoBlockedText,
  undoCandidates,
  undoConfirmText,
} from './submission';

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

describe('undo wording', () => {
  const item = (over: Partial<SubmissionItemView>): SubmissionItemView => ({
    playerId: '1' as SubmissionItemView['playerId'],
    displayName: 'Misty',
    origin: 'session',
    outcome: 'added',
    error: null,
    recordId: 'rec-1',
    asStaff: false,
    removedBy: null,
    ...over,
  });

  it('labels an undo in the history list with the submission it undoes', () => {
    expect(historyLabel({ kind: 'undo', undoOf: 7 })).toBe('Undo of #7');
    expect(historyLabel({ kind: 'submit', undoOf: null })).toBeNull();
  });

  it('lists who the undo would remove: added players with a record, not removed yet', () => {
    const items = [
      item({ playerId: '1' as never, displayName: 'Misty' }),
      item({ playerId: '2' as never, displayName: 'Brock', removedBy: 9 }),
      item({ playerId: '3' as never, displayName: 'Ash', recordId: null }),
      item({ playerId: '4' as never, displayName: 'Gary', outcome: 'already_present' }),
    ];
    expect(undoCandidates(items)).toEqual({ names: ['Misty'], withoutRecord: 1 });
  });

  it('confirms what removing does, including the date list and the marks, and that regulars stay', () => {
    expect(undoConfirmText(3)).toBe(
      'Remove 3 players from play-tools? They will be taken off this date\'s player list and their TDF and "present" marks for that date cleared. Regulars stay regulars.',
    );
    expect(undoConfirmText(1)).toMatch(/^Remove 1 player from play-tools\?/);
  });

  it('says why a submission cannot be undone', () => {
    expect(undoBlockedText({ kind: 'submit', undoBlockedReason: 'nothing_to_undo', items: [item({ removedBy: 4 })] })).toBe('Already undone');
    expect(undoBlockedText({ kind: 'submit', undoBlockedReason: 'nothing_to_undo', items: [item({ outcome: 'already_present' })] })).toBe(
      'Nothing to undo: this submission added nobody.',
    );
    expect(undoBlockedText({ kind: 'submit', undoBlockedReason: 'not_undoable', items: [] })).toBe('Only a finished submission can be undone.');
    expect(undoBlockedText({ kind: 'undo', undoBlockedReason: 'not_undoable', items: [] })).toBe("An undo can't be undone.");
    expect(undoBlockedText({ kind: 'submit', undoBlockedReason: null, items: [] })).toBeNull();
  });

  it('labels a running undo as removing, not sending', () => {
    expect(submissionStatus('running', 'undo')).toEqual({ label: 'Removing…', color: 'info' });
    expect(submissionStatus('running', 'submit')).toEqual({ label: 'Sending…', color: 'info' });
  });
});
