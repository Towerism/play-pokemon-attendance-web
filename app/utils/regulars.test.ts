import { describe, expect, it } from 'vitest';
import { withPlayerRegular, withRegularPresence } from './regulars';

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

describe('withPlayerRegular', () => {
  const player = (playerId: string, isRegular = false) => ({ playerId, displayName: `Player ${playerId}`, isRegular, notes: null });
  const list = () => ({ players: [player('6000030'), player('6000031', true)], thresholds: { promoteMinSightings: 3, staleAfterSessions: 4 } });

  it('returns a new list with only that player replaced, leaving the input as it was', () => {
    const before = list();
    const snapshot = structuredClone(before);

    const after = withPlayerRegular(before, '6000030', true);

    expect(after).not.toBe(before);
    expect(after.players).not.toBe(before.players);
    expect(after.players[0]).toEqual({ ...before.players[0], isRegular: true });
    expect(after.players[1]).toBe(before.players[1]);
    expect(after.thresholds).toBe(before.thresholds);
    expect(before).toEqual(snapshot);
  });

  it('can turn a regular off', () => {
    expect(withPlayerRegular(list(), '6000031', false).players[1]!.isRegular).toBe(false);
  });

  it('returns the same list when the player is not in it', () => {
    const before = list();

    expect(withPlayerRegular(before, '6000099', true)).toBe(before);
  });
});
