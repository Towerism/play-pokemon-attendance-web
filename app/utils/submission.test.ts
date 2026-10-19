import { describe, expect, it } from 'vitest';
import type { PlayerId } from '../../shared/types/ids';
import type { SubmissionItemView } from '../../server/modules/submission/service';
import {
  clearConfirmText,
  clearConfirmed,
  historyLabel,
  isSubmissionActive,
  playerImportSummary,
  progressPercent,
  staffImportErrorText,
  staffImportSummary,
  isTournamentJob,
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

  it.each([
    ['tournament_create', 'Creating…'],
    ['tournament_edit', 'Editing…'],
    ['tournament_cancel', 'Cancelling…'],
    ['tdf_upload', 'Uploading…'],
    ['undo', 'Removing…'],
    ['clear', 'Removing…'],
  ] as const)('says what a running %s is doing', (kind, label) => {
    expect(submissionStatus('running', kind)).toEqual({ label, color: 'info' });
    expect(submissionStatus('succeeded', kind)).toEqual({ label: 'Done', color: 'success' });
  });
});

describe('isTournamentJob', () => {
  it('is true for the jobs that list tournaments, not players', () => {
    const kinds = ['submit', 'undo', 'clear', 'staff', 'staff_import', 'player_import', 'tournament_create', 'tournament_edit', 'tournament_cancel', 'tdf_upload'] as const;
    expect(kinds.filter((k) => isTournamentJob(k))).toEqual(['tournament_create', 'tournament_edit', 'tournament_cancel', 'tdf_upload']);
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
    role: null,
    errorCode: null,
    suggestedPlayerId: null,
    ...over,
  });

  it('labels an undo in the history list with the submission it undoes', () => {
    expect(historyLabel({ kind: 'undo', undoOf: 7, playSessionLabel: 'Open play' })).toBe('Undo of #7');
    expect(historyLabel({ kind: 'submit', undoOf: null, playSessionLabel: 'Open play' })).toBeNull();
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

describe('clear session wording', () => {
  it('labels a clear in the history list with the play session it cleared', () => {
    expect(historyLabel({ kind: 'clear', undoOf: null, playSessionLabel: 'Open play · TCG · Tue 6:00 PM' })).toBe(
      'Cleared session Open play · TCG · Tue 6:00 PM',
    );
  });

  it('says a running clear is removing, and that a clear cannot be undone', () => {
    expect(submissionStatus('running', 'clear')).toEqual({ label: 'Removing…', color: 'info' });
    expect(undoBlockedText({ kind: 'clear', undoBlockedReason: 'not_undoable', items: [] })).toBe("A cleared session can't be undone.");
  });

  it('confirms only when the typed text is exactly the date', () => {
    expect(clearConfirmed('2026-10-13', '2026-10-13')).toBe(true);
    for (const typed of ['', '2026-10-1', '2026-10-14', ' 2026-10-13', '2026-10-13 ', '10/13/2026']) {
      expect(clearConfirmed(typed, '2026-10-13'), typed).toBe(false);
    }
  });

  it('says how many players go, that staff records stay, and warns about another play session that day', () => {
    const player = (playerId: string, name: string, addedByApp: boolean) => ({ playerId: playerId as PlayerId, name, addedByApp });
    const preview = { players: [player('1', 'Ash', true)], staffKept: 1, otherSessionHasAppRecords: false };
    expect(clearConfirmText(preview)).toBe(
      'Delete 1 player from this play session in play-tools, including anyone entered there directly. 1 staff record stays.',
    );
    expect(
      clearConfirmText({ ...preview, players: [...preview.players, player('2', '', false)], staffKept: 0, otherSessionHasAppRecords: true }),
    ).toBe(
      'Delete 2 players from this play session in play-tools, including anyone entered there directly. ' +
        "Another play session that day also has players from this app; this date's player list and TDF imports are reset for the whole date.",
    );
  });
});

describe('a staff import in History and Settings', () => {
  const result = { tournamentsTotal: 117, tournamentsRead: 117, tournamentsFailed: 0, staffersFound: 42, newPlayers: [] };

  it('is labelled "Staff import" in the history list, reads while running, and cannot be undone', () => {
    expect(historyLabel({ kind: 'staff_import', undoOf: null, playSessionLabel: 'Staff import' })).toBe('Staff import');
    expect(submissionStatus('running', 'staff_import')).toEqual({ label: 'Reading…', color: 'info' });
    expect(undoBlockedText({ kind: 'staff_import', undoBlockedReason: 'not_undoable', items: [] })).toBe("A staff import can't be undone.");
  });

  it('sums up what it read and found, leaving out the zeros', () => {
    expect(staffImportSummary(result)).toBe('Read 117 of 117 tournaments · 42 staff found');
    const newPlayers = [{ playerId: '1' as PlayerId, name: 'Jo Judge' }];
    expect(staffImportSummary({ ...result, tournamentsRead: 115, tournamentsFailed: 2, newPlayers })).toBe(
      'Read 115 of 117 tournaments · 2 could not be read · 42 staff found · 1 new player',
    );
    expect(staffImportSummary({ ...result, newPlayers: [...newPlayers, { playerId: '2' as PlayerId, name: '' }] })).toBe(
      'Read 117 of 117 tournaments · 42 staff found · 2 new players',
    );
    expect(staffImportSummary({ tournamentsTotal: 0, tournamentsRead: 0, tournamentsFailed: 0, staffersFound: 0, newPlayers: [] })).toBe(
      'No tournaments to read',
    );
  });

  it('explains why an import (staff or player) stopped, in words, keeping any other message as it is', () => {
    expect(staffImportErrorText('forbidden')).toBe('play-tools refused to show these tournaments. Check which Pokémon account is connected.');
    expect(staffImportErrorText('needs_reconnect')).toBe('The Pokémon account needs reconnecting. Reconnect it above, then retry.');
    expect(staffImportErrorText('unavailable')).toBe('play-tools could not be reached. Try again later.');
    expect(staffImportErrorText('not_found')).toBe('No tournament could be read.');
    expect(staffImportErrorText('The app stopped while this submission was running. Resume it to finish.')).toBe(
      'The app stopped while this submission was running. Resume it to finish.',
    );
  });
});

describe('staff jobs in History', () => {
  it('labels a staff job with its tournament', () => {
    expect(historyLabel({ kind: 'staff', undoOf: null, playSessionLabel: 'Staff for League Cup · 0001', tournamentLabel: 'League Cup · 0001' })).toBe(
      'Staff for League Cup · 0001',
    );
  });

  it('says a running staff job is assigning, not removing', () => {
    expect(submissionStatus('running', 'staff')).toEqual({ label: 'Assigning…', color: 'info' });
    expect(submissionStatus('running', 'undo')).toEqual({ label: 'Removing…', color: 'info' });
    expect(submissionStatus('succeeded', 'staff')).toEqual({ label: 'Done', color: 'success' });
  });

  it('offers no undo for a staff job, and says where staff are changed', () => {
    expect(undoBlockedText({ kind: 'staff', undoBlockedReason: 'not_undoable', items: [] })).toBe('Staff are changed from This week, not undone.');
  });
});

describe('a player import in History and Settings', () => {
  const result = { tournamentsTotal: 117, tournamentsRead: 117, tournamentsFailed: 0, playersFound: 640, newPlayers: [] };

  it('is labelled "Player import" in the history list, reads while running, and cannot be undone', () => {
    expect(historyLabel({ kind: 'player_import', undoOf: null, playSessionLabel: 'Player import' })).toBe('Player import');
    expect(submissionStatus('running', 'player_import')).toEqual({ label: 'Reading…', color: 'info' });
    expect(undoBlockedText({ kind: 'player_import', undoBlockedReason: 'not_undoable', items: [] })).toBe("A player import can't be undone.");
  });

  it('sums up what it read and found, leaving out the zeros', () => {
    const one = [{ playerId: '1' as PlayerId, name: 'Pat Player' }];
    expect(playerImportSummary(result)).toBe('Read 117 of 117 tournaments · 640 players found');
    expect(playerImportSummary({ ...result, tournamentsRead: 115, tournamentsFailed: 2, playersFound: 1, newPlayers: one })).toBe(
      'Read 115 of 117 tournaments · 2 could not be read · 1 player found · 1 new player',
    );
    expect(playerImportSummary({ ...result, newPlayers: [...one, { playerId: '2' as PlayerId, name: '' }] })).toBe(
      'Read 117 of 117 tournaments · 640 players found · 2 new players',
    );
    expect(playerImportSummary({ tournamentsTotal: 0, tournamentsRead: 0, tournamentsFailed: 0, playersFound: 0, newPlayers: [] })).toBe(
      'No tournaments to read',
    );
  });
});
