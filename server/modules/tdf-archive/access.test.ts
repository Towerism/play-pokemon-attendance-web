import { describe, expect, it } from 'vitest';
import { OWNER, professorActor } from '../pokemon/test-helpers';
import { mayAccessTdf } from './access';

const MISTY = professorActor(2, 'misty');

describe('who may list, download or delete a stored TDF (ADR-0015 §4)', () => {
  it('lets the owner reach every file', () => {
    expect(mayAccessTdf(OWNER, { id: 1, createdBy: 'misty' }, new Set())).toBe(true);
  });

  it('lets a professor reach a file they uploaded', () => {
    expect(mayAccessTdf(MISTY, { id: 1, createdBy: 'misty' }, new Set())).toBe(true);
  });

  it("lets a professor reach a file of a results upload for a tournament they organize", () => {
    expect(mayAccessTdf(MISTY, { id: 7, createdBy: 'organizer' }, new Set([7]))).toBe(true);
  });

  it("keeps a professor from anyone else's file", () => {
    expect(mayAccessTdf(MISTY, { id: 7, createdBy: 'organizer' }, new Set([8]))).toBe(false);
  });
});
