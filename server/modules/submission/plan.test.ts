import { describe, expect, it } from 'vitest';
import type { PlayerId } from '../../../shared/types/ids';
import type { AttendanceRecord } from '../pokemon/ports/play-tools-gateway';
import { planSubmission } from './plan';

const id = (s: string) => s as PlayerId;
const session = (...ids: string[]) => ids.map((p) => ({ playerId: id(p), origin: 'session' as const }));
const regular = (...ids: string[]) => ids.map((p) => ({ playerId: id(p), origin: 'regular' as const }));
const rec = (playerId: string, over: Partial<AttendanceRecord> = {}): AttendanceRecord => ({
  recordId: `r-${playerId}`,
  playerId: id(playerId),
  isPlayer: true,
  name: '',
  ...over,
});

describe('planSubmission (ADR-0004: toAdd = desired − existing)', () => {
  it('sends everyone to an empty session, session players before regulars (as the CLI did)', () => {
    const plan = planSubmission([...regular('9', '8'), ...session('2', '1')], []);
    expect(plan.toAdd).toEqual([...session('2', '1'), ...regular('9', '8')]);
    expect(plan.alreadyPresent).toEqual([]);
    expect(plan.extra).toEqual([]);
  });

  it('sends only who upstream is missing', () => {
    const plan = planSubmission([...session('1', '2'), ...regular('9')], [rec('2'), rec('9')]);
    expect(plan.toAdd).toEqual(session('1'));
    expect(plan.alreadyPresent).toEqual([
      { playerId: '2', origin: 'session', recordId: 'r-2', asStaff: false },
      { playerId: '9', origin: 'regular', recordId: 'r-9', asStaff: false },
    ]);
  });

  it('counts a staff record as present: upstream refuses to add that participant again (design change 6)', () => {
    const plan = planSubmission(regular('9'), [rec('9', { isPlayer: false })]);
    expect(plan.toAdd).toEqual([]);
    expect(plan.alreadyPresent).toEqual([{ playerId: '9', origin: 'regular', recordId: 'r-9', asStaff: true }]);
  });

  it('reports upstream players nobody asked for, and never plans to delete them', () => {
    const walkIn = rec('5', { name: 'Walk In' });
    const plan = planSubmission(session('1'), [walkIn, rec('6', { isPlayer: false })]);
    expect(plan.extra).toEqual([walkIn]);
    expect(plan).not.toHaveProperty('toRemove');
  });

  it('lists a player once even if they are desired twice', () => {
    expect(planSubmission([...session('1'), ...regular('1')], []).toAdd).toEqual(session('1'));
  });

  it('is a no-op when upstream already has everyone (safe to click Submit twice)', () => {
    expect(planSubmission(session('1', '2'), [rec('1'), rec('2')]).toAdd).toEqual([]);
  });

  it('compares player ids exactly, so leading zeros matter', () => {
    expect(planSubmission(session('0012'), [rec('12')]).toAdd).toEqual(session('0012'));
  });
});
