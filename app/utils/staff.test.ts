import { describe, expect, it } from 'vitest';
import { lastStaffedLabel, renameDecision, roleLabel } from './staff';

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
