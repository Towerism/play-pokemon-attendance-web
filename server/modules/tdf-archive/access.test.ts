import { describe, expect, it } from 'vitest';
import { OWNER, professorActor } from '../pokemon/test-connections';
import { type TdfReach, mayAccessTdf } from './access';

const MISTY = professorActor(2, 'misty');
const reach = (over: Partial<TdfReach> = {}): TdfReach => ({ organized: new Set(), leased: new Set(), results: new Set(), ...over });

describe('who may list, download or delete a stored TDF (ADR-0015 §4)', () => {
  it('lets the owner reach every file', () => {
    for (const use of ['list', 'download', 'delete'] as const) expect(mayAccessTdf(OWNER, { id: 1, createdBy: 'misty' }, reach(), use)).toBe(true);
  });

  it('lets a professor reach a file they uploaded', () => {
    for (const use of ['list', 'download', 'delete'] as const) expect(mayAccessTdf(MISTY, { id: 1, createdBy: 'misty' }, reach(), use)).toBe(true);
  });

  it('lets a professor reach a file of a results upload for a tournament they organize', () => {
    for (const use of ['list', 'download', 'delete'] as const) {
      expect(mayAccessTdf(MISTY, { id: 7, createdBy: 'organizer' }, reach({ organized: new Set([7]), results: new Set([7]) }), use)).toBe(true);
    }
  });

  it("keeps a professor from anyone else's file", () => {
    for (const use of ['list', 'download', 'delete'] as const) {
      expect(mayAccessTdf(MISTY, { id: 7, createdBy: 'organizer' }, reach({ organized: new Set([8]) }), use)).toBe(false);
    }
  });
});

describe('stored TDFs under a lease (ADR-0015 §5)', () => {
  it("lets the lent professor download the leased tournament's results files, but not list or delete them", () => {
    const leased = reach({ leased: new Set([7]), results: new Set([7]) });
    expect(mayAccessTdf(MISTY, { id: 7, createdBy: 'organizer' }, leased, 'download')).toBe(true);
    expect(mayAccessTdf(MISTY, { id: 7, createdBy: 'organizer' }, leased, 'list')).toBe(false);
    expect(mayAccessTdf(MISTY, { id: 7, createdBy: 'organizer' }, leased, 'delete')).toBe(false);
  });

  it("never lets a professor delete a results file of a tournament they don't organize, even one they uploaded", () => {
    const theirs = reach({ results: new Set([9]) });
    expect(mayAccessTdf(MISTY, { id: 9, createdBy: 'misty' }, theirs, 'list')).toBe(true);
    expect(mayAccessTdf(MISTY, { id: 9, createdBy: 'misty' }, theirs, 'download')).toBe(true);
    expect(mayAccessTdf(MISTY, { id: 9, createdBy: 'misty' }, theirs, 'delete')).toBe(false);
  });
});
