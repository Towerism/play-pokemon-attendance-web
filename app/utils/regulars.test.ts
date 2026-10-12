import { describe, expect, it } from 'vitest';
import { withRegularPresence } from './regulars';

const regular = (playerId: string, present = false, inTournament = false) => ({ playerId, displayName: `Player ${playerId}`, present, inTournament });

function session() {
  return {
    status: 'draft' as const,
    players: [{ playerId: '6000001', displayName: 'Ash', source: 'manual' }],
    regulars: [regular('6000020'), regular('6000021', true)],
  };
}

describe('withRegularPresence', () => {
  it('returns a new session with only that regular replaced, leaving the input as it was', () => {
    const before = session();
    const snapshot = structuredClone(before);

    const after = withRegularPresence(before, '6000020', { present: true, inTournament: false });

    expect(after).not.toBe(before);
    expect(after.regulars).not.toBe(before.regulars);
    expect(after.regulars[0]).not.toBe(before.regulars[0]);
    expect(after.regulars[0]).toEqual({ ...before.regulars[0], present: true });
    expect(after.regulars[1]).toBe(before.regulars[1]);
    expect(after.players).toBe(before.players);
    expect(after.status).toBe('draft');
    expect(before).toEqual(snapshot);
  });

  it("takes the server's values over the guess made on click", () => {
    const optimistic = withRegularPresence(session(), '6000020', { present: true });

    const confirmed = withRegularPresence(optimistic, '6000020', { present: true, inTournament: true });

    expect(confirmed.regulars[0]).toMatchObject({ present: true, inTournament: true });
  });

  it('can untick a regular', () => {
    expect(withRegularPresence(session(), '6000021', { present: false }).regulars[1]!.present).toBe(false);
  });

  it('returns the same session when the player is not one of its regulars', () => {
    const before = session();

    expect(withRegularPresence(before, '6000099', { present: true })).toBe(before);
  });
});
