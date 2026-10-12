import { describe, expect, it } from 'vitest';
import { ASSIGNABLE_ROLES, addedFor, missingFrom, otherRole, pickStaffer, repairActions, toStaff, withinAddWindow, type Staff } from './staff';

const rec = (guid: string, player_id: string, role: string | null) => ({ guid, role, participant: { player_id } });

describe('toStaff', () => {
  it('maps records to record guid, player id and role, failing loudly on unexpected shapes', () => {
    expect(toStaff([rec('r1', '0012345', 'judge')])).toEqual([{ recordId: 'r1', playerId: '0012345', role: 'judge' }]);
    expect(() => toStaff([{ role: 'judge' }])).toThrow(/unexpected staff record/);
  });
});

describe('pickStaffer', () => {
  it('picks a non-organizer whose role the Staff tab can assign, so the re-add uses the same role', () => {
    const staff = toStaff([rec('o', '1', 'organizer'), rec('g', '2', 'generic-staff'), rec('j', '3', 'scorekeeper')]);
    expect(pickStaffer(staff)).toEqual({ recordId: 'j', playerId: '3', role: 'scorekeeper' });
  });

  it('needs at least two staff, counting the organizer', () => {
    expect(pickStaffer(toStaff([rec('j', '3', 'judge')]))).toBeUndefined();
    expect(pickStaffer(toStaff([rec('o', '1', 'organizer'), rec('j', '3', 'judge')]))?.recordId).toBe('j');
  });

  it('returns nothing when only the organizer or unassignable roles are present', () => {
    expect(pickStaffer(toStaff([rec('o', '1', 'organizer'), rec('g', '2', 'generic-staff')]))).toBeUndefined();
  });
});

describe('withinAddWindow', () => {
  const start = '2026-07-15T16:00:00Z';
  it('is open until 90 days after the start, with a day of margin for the probe itself', () => {
    expect(withinAddWindow(start, new Date('2026-10-11T00:00:00Z'))).toBe(true);
    expect(withinAddWindow(start, new Date('2026-10-12T16:00:01Z'))).toBe(false);
    expect(withinAddWindow(start, new Date('2026-10-13T00:00:00Z'))).toBe(false);
  });
  it('rejects a missing or unparseable start date', () => {
    expect(withinAddWindow(undefined, new Date())).toBe(false);
    expect(withinAddWindow('soon', new Date())).toBe(false);
  });
});

describe('otherRole', () => {
  it('is an assignable role different from the given one', () => {
    for (const r of ASSIGNABLE_ROLES) {
      expect(otherRole(r)).not.toBe(r);
      expect(ASSIGNABLE_ROLES).toContain(otherRole(r));
    }
  });
});

describe('repairActions', () => {
  const before = toStaff([rec('o', '1', 'organizer'), rec('j', '3', 'judge'), rec('k', '4', 'scorekeeper')]);
  const target = { recordId: 'j', playerId: '3', role: 'judge' };
  const repair = (after: Staff[]) => repairActions(before, after, target, '0');

  it('is done when the list matches the snapshot, even with a new record guid for the staffer', () => {
    expect(repair(toStaff([rec('o', '1', 'organizer'), rec('NEW', '3', 'judge'), rec('k', '4', 'scorekeeper')]))).toEqual({
      add: false,
      setRole: undefined,
      remove: [],
      othersMissing: [],
    });
  });

  it('re-adds the staffer when they are gone', () => {
    expect(repair(toStaff([rec('o', '1', 'organizer'), rec('k', '4', 'scorekeeper')])).add).toBe(true);
  });

  it('puts back the original role when the staffer is present with another one', () => {
    const r = repair(toStaff([rec('o', '1', 'organizer'), rec('NEW', '3', 'administration'), rec('k', '4', 'scorekeeper')]));
    expect(r).toMatchObject({ add: false, setRole: { recordId: 'NEW', role: 'judge' }, remove: [] });
  });

  it('removes duplicates of the staffer (keeping the one with the original role) and any invalid-id record', () => {
    const r = repair(
      toStaff([rec('o', '1', 'organizer'), rec('A', '3', 'administration'), rec('B', '3', 'judge'), rec('k', '4', 'scorekeeper'), rec('Z', '0', 'judge')]),
    );
    expect(r).toMatchObject({ add: false, setRole: undefined });
    expect(r.remove.map((s) => s.recordId).sort()).toEqual(['A', 'Z']);
  });

  it('never touches other staff, only reports them missing', () => {
    const r = repair(toStaff([rec('o', '1', 'organizer'), rec('j', '3', 'judge')]));
    expect(r.othersMissing).toEqual([{ recordId: 'k', playerId: '4', role: 'scorekeeper' }]);
    expect(r.remove).toEqual([]);
  });
});

describe('addedFor', () => {
  it("lists only the player's records that were not in the snapshot", () => {
    const before = toStaff([rec('o', '1', 'organizer'), rec('j', '3', 'judge')]);
    const after = toStaff([rec('o', '1', 'organizer'), rec('j', '3', 'judge'), rec('N1', '7', 'judge'), rec('N2', '8', 'judge')]);
    expect(addedFor(before, after, '7')).toEqual([{ recordId: 'N1', playerId: '7', role: 'judge' }]);
    expect(addedFor(before, after, '3')).toEqual([]);
  });
});

describe('missingFrom', () => {
  it('lists (player id, role) pairs from before that are absent after, ignoring record guids', () => {
    const before = toStaff([rec('o', '1', 'organizer'), rec('j', '3', 'judge')]);
    expect(missingFrom(before, toStaff([rec('o', '1', 'organizer'), rec('NEW', '3', 'judge')]))).toEqual([]);
    expect(missingFrom(before, toStaff([rec('o', '1', 'organizer'), rec('NEW', '3', 'scorekeeper')]))).toEqual([
      { recordId: 'j', playerId: '3', role: 'judge' },
    ]);
    expect(missingFrom(before, toStaff([rec('o', '1', 'organizer')]))).toHaveLength(1);
  });
});
