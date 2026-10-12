import { describe, expect, it } from 'vitest';
import type { StaffOutcome } from './staff';
import {
  alreadyListedText,
  alreadyStaffingText,
  applyStartText,
  defaultRole,
  lastStaffedLabel,
  needsAttention,
  renameDecision,
  roleLabel,
  staffOutcomeText,
  staffSummary,
  staffTag,
  toStaffResults,
} from './staff';

const ROLES = [
  { code: 'judge', label: 'Judge' },
  { code: 'administration', label: 'Support Staff' },
];

describe('roleLabel', () => {
  it('shows the label play-tools gives a role', () => {
    expect(roleLabel('administration', ROLES)).toBe('Support Staff');
    expect(roleLabel('judge', ROLES)).toBe('Judge');
  });

  it('falls back to the raw code for a role the app does not offer', () => {
    expect(roleLabel('organizer', ROLES)).toBe('organizer');
  });

  it('falls back to the raw code while the roles could not be loaded', () => {
    expect(roleLabel('judge', undefined)).toBe('judge');
  });
});

describe('lastStaffedLabel', () => {
  it('shows the date of the latest tournament they staffed', () => {
    expect(lastStaffedLabel('2026-10-07')).toBe('2026-10-07');
  });

  it('shows a dash when none of their tournaments has a date', () => {
    expect(lastStaffedLabel(null)).toBe('—');
  });
});

describe('renameDecision', () => {
  it.each(['', '   ', '\t'])('blocks an empty name (%j)', (draft) => {
    expect(renameDecision(draft, 'Old Name')).toEqual({ kind: 'blocked' });
  });

  it('sends nothing when the name is unchanged', () => {
    expect(renameDecision('Old Name', 'Old Name')).toEqual({ kind: 'unchanged' });
    expect(renameDecision('  Old Name ', 'Old Name')).toEqual({ kind: 'unchanged' });
  });

  it('sends a changed name as typed, for the server to trim', () => {
    expect(renameDecision(' New Name ', 'Old Name')).toEqual({ kind: 'send', name: ' New Name ' });
  });

  it('sends a first name for a staffer the app could not name', () => {
    expect(renameDecision('Brock', '')).toEqual({ kind: 'send', name: 'Brock' });
  });
});

describe('toStaffResults', () => {
  const card = {
    organizer: { playerId: '9000001' },
    players: [{ playerId: '9000004' }],
    assignments: [{ playerId: '9000002', role: 'scorekeeper', state: 'pending' as const }],
    upstreamOnly: [{ playerId: '9000003', name: 'Up Stream', role: 'headjudge' }],
  };
  const staffEntry = (playerId: string, name: string, lastRole = 'judge') => ({ playerId, name, timesStaffed: 1, lastStaffedOn: '2026-10-06', lastRole });
  const player = (playerId: string, displayName: string) => ({ playerId, displayName, isRegular: false });

  it('lists staff-list matches first, then known players, each person once with the staff entry winning', () => {
    const results = toStaffResults([staffEntry('6000011', 'Ash Judge', 'headjudge')], [player('6000012', 'Ash Player'), player('6000011', 'Ash Judge')], {
      ...card,
      organizer: null,
    });
    expect(results).toEqual([
      { playerId: '6000011', name: 'Ash Judge', lastRole: 'headjudge', status: 'addable', role: null },
      { playerId: '6000012', name: 'Ash Player', lastRole: null, status: 'addable', role: null },
    ]);
  });

  it('marks the organizer, players staffing here, play-tools staff and players as not pickable, with how they are listed', () => {
    const results = toStaffResults(
      [staffEntry('9000001', 'Org'), staffEntry('9000002', 'Local'), staffEntry('9000003', 'Up Stream')],
      [player('9000004', 'Playing Pat')],
      card,
    );
    expect(results.map(({ playerId, status, role }) => ({ playerId, status, role }))).toEqual([
      { playerId: '9000001', status: 'organizer', role: null },
      { playerId: '9000002', status: 'staffing', role: 'scorekeeper' },
      { playerId: '9000003', status: 'upstreamStaff', role: 'headjudge' },
      { playerId: '9000004', status: 'playing', role: null },
    ]);
  });

  it('calls the organizer the organizer even when play-tools also lists them', () => {
    const results = toStaffResults([], [player('9000001', 'Org')], { ...card, players: [{ playerId: '9000001' }] });
    expect(results[0]!.status).toBe('organizer');
  });

  it('lets someone whose staff row is being removed be picked again', () => {
    const results = toStaffResults([staffEntry('9000002', 'Local')], [], {
      ...card,
      assignments: [{ playerId: '9000002', role: 'judge', state: 'removing' }],
    });
    expect(results[0]!.status).toBe('addable');
  });

  it('compares player ids exactly, leading zeros included', () => {
    const results = toStaffResults([], [player('0900004', 'Zero Lead')], card);
    expect(results[0]!.status).toBe('addable');
  });
});

describe('defaultRole', () => {
  const roles = [
    { code: 'judge', label: 'Judge' },
    { code: 'headjudge', label: 'Head Judge' },
  ];

  it('pre-fills the role they last staffed in', () => {
    expect(defaultRole('headjudge', roles)).toBe('headjudge');
  });

  it('uses the first role (Judge) for someone who never staffed', () => {
    expect(defaultRole(null, roles)).toBe('judge');
  });

  it('uses the first role when their last role is no longer offered', () => {
    expect(defaultRole('translator', roles)).toBe('judge');
  });

  it('uses judge while the roles could not be loaded', () => {
    expect(defaultRole('headjudge', undefined)).toBe('judge');
    expect(defaultRole(null, [])).toBe('judge');
  });
});

describe('staffTag', () => {
  const roles = [{ code: 'scorekeeper', label: 'Scorekeeper' }];

  it('says how someone who cannot be picked is listed', () => {
    expect(staffTag({ status: 'organizer', role: null }, roles)).toBe('Organizer');
    expect(staffTag({ status: 'staffing', role: 'scorekeeper' }, roles)).toBe('Staffing as Scorekeeper');
    expect(staffTag({ status: 'upstreamStaff', role: 'headjudge' }, roles)).toBe('headjudge in play-tools');
    expect(staffTag({ status: 'playing', role: null }, roles)).toBe('Playing');
  });

  it('has no tag for someone who can be picked', () => {
    expect(staffTag({ status: 'addable', role: null }, roles)).toBeUndefined();
  });
});

describe('staffSummary', () => {
  const items = (...outcomes: StaffOutcome[]) => outcomes.map((outcome) => ({ outcome }));

  it('counts what happened, leaving out the zeros', () => {
    expect(staffSummary(items('assigned', 'assigned', 'ineligible', 'already_assigned'))).toBe('2 assigned · 1 not eligible · 1 already in play-tools');
    expect(staffSummary(items('assigned', 'ineligible'))).toBe('1 assigned · 1 not eligible');
  });

  it('names every staff outcome', () => {
    expect(
      staffSummary(
        items('assigned', 'role_changed', 'removed', 'ineligible', 'failed', 'skipped', 'already_assigned', 'already_listed', 'is_organizer', 'already_removed', 'pending'),
      ),
    ).toBe(
      '1 assigned · 1 role changed · 1 removed · 1 not eligible · 1 failed · 1 not sent · 1 already in play-tools · 1 already listed · 1 organizer · 1 already gone · 1 waiting',
    );
  });

  it('says so when there was nothing to send', () => {
    expect(staffSummary([])).toBe('Nothing to send');
  });
});

describe('staffOutcomeText', () => {
  it("shows play-tools' refusal as the server words it, suggestion included", () => {
    const error = 'merged_player_id: Merged into 7000001. Edit the assignment to use that ID';
    expect(staffOutcomeText({ outcome: 'ineligible', error })).toBe(error);
    expect(staffOutcomeText({ outcome: 'failed', error: 'tournament_locked' })).toBe('tournament_locked');
  });

  it('falls back to the outcome when there is no reason', () => {
    expect(staffOutcomeText({ outcome: 'ineligible', error: null })).toBe('not eligible');
    expect(staffOutcomeText({ outcome: 'failed', error: null })).toBe('failed');
  });

  it('explains why nothing was sent for someone', () => {
    expect(staffOutcomeText({ outcome: 'already_listed', error: null })).toBe('already listed in play-tools');
    expect(staffOutcomeText({ outcome: 'is_organizer', error: null })).toBe('organizes this tournament');
    expect(staffOutcomeText({ outcome: 'skipped', error: null })).toBe('not sent');
  });
});

describe('needsAttention', () => {
  it('lists the staffers the organizer should look at after a run', () => {
    const all: StaffOutcome[] = ['assigned', 'already_assigned', 'already_listed', 'is_organizer', 'role_changed', 'ineligible', 'removed', 'already_removed', 'failed', 'skipped', 'pending'];
    expect(all.filter((outcome) => needsAttention({ outcome }))).toEqual(['already_listed', 'is_organizer', 'ineligible', 'failed', 'skipped']);
  });
});

describe('applyStartText', () => {
  it('words the refusals the organizer can act on', () => {
    expect(applyStartText('nothing_to_apply')).toBe('Nothing to send: play-tools already matches this list.');
    expect(applyStartText('submission_running')).toBe('Another job is running for this league. Try again when it finishes.');
  });

  it("leaves any other code to the server's message", () => {
    expect(applyStartText('tournament_locked')).toBeUndefined();
    expect(applyStartText(undefined)).toBeUndefined();
  });
});

describe('add refusals', () => {
  const roles = [{ code: 'headjudge', label: 'Head Judge' }];

  it('says who play-tools already lists, and how', () => {
    expect(alreadyListedText({ name: 'Ash Late', playerId: '6000016' }, 'player')).toBe('Ash Late is already listed in play-tools as a player.');
    expect(alreadyListedText({ name: '', playerId: '6000016' }, 'staff')).toBe('6000016 is already listed in play-tools as staff.');
    expect(alreadyListedText({ name: 'Ash', playerId: '1' }, undefined)).toBe('Ash is already listed in play-tools.');
  });

  it('says someone is already staffing in the role picked', () => {
    expect(alreadyStaffingText({ name: 'Ash Judge', playerId: '6000011', role: 'headjudge' }, roles)).toBe('Ash Judge is already staffing as Head Judge.');
  });
});
