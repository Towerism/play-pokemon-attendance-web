import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEARCH_DEBOUNCE_MS, createPlayerSearch, playerSearchTerm, toSearchResults } from './player-search';

describe('playerSearchTerm', () => {
  it('trims what was typed', () => {
    expect(playerSearchTerm('  ash ')).toBe('ash');
  });

  it.each(['', ' ', 'a', ' 1 '])('is undefined for %j: under two characters is too short to search', (typed) => {
    expect(playerSearchTerm(typed)).toBeUndefined();
  });

  it('keeps leading zeros', () => {
    expect(playerSearchTerm('04')).toBe('04');
  });
});

describe('toSearchResults', () => {
  const players = [
    { playerId: '0011', displayName: 'Ash Ketchum', isRegular: false },
    { playerId: '4200', displayName: 'Misty', isRegular: true },
    { playerId: '4300', displayName: 'Dawn', isRegular: true },
    { playerId: '0042', displayName: 'Brock', isRegular: false },
    { playerId: '7', displayName: '', isRegular: false },
  ];
  const session = (playerIds: string[] = [], presentRegularIds: string[] = []) => ({
    playerIds: new Set(playerIds),
    presentRegularIds: new Set(presentRegularIds),
  });

  it('tags each player by what picking them does: add, mark present, or nothing', () => {
    expect(toSearchResults(players, session(['0042'], ['4300']))).toEqual([
      { playerId: '0011', displayName: 'Ash Ketchum', status: 'addable' },
      { playerId: '4200', displayName: 'Misty', status: 'markPresent' },
      { playerId: '4300', displayName: 'Dawn', status: 'present' },
      { playerId: '0042', displayName: 'Brock', status: 'alreadyAdded' },
      { playerId: '7', displayName: '', status: 'addable' },
    ]);
  });

  it('treats a regular as a regular even if they are listed in the session too', () => {
    expect(toSearchResults([players[1]!], session(['4200']))[0]!.status).toBe('markPresent');
    expect(toSearchResults([players[1]!], session(['4200'], ['4200']))[0]!.status).toBe('present');
  });

  it('ignores the present list for a non-regular', () => {
    expect(toSearchResults([players[0]!], session([], ['0011']))[0]!.status).toBe('addable');
  });

  it('compares ids as text, so 42 is not 0042', () => {
    expect(toSearchResults([players[3]!], session(['42']))[0]!.status).toBe('addable');
    expect(toSearchResults([players[1]!], session([], ['04200']))[0]!.status).toBe('markPresent');
  });
});

describe('createPlayerSearch', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A fetcher whose responses the test resolves (or rejects) by hand, in any order. */
  function controlledFetcher() {
    const calls: { q: string; resolve: (v: string[]) => void; reject: (e: unknown) => void }[] = [];
    const fetcher = vi.fn(
      (q: string) =>
        new Promise<string[]>((resolve, reject) => {
          calls.push({ q, resolve, reject });
        }),
    );
    return { fetcher, calls };
  }

  function setup() {
    const { fetcher, calls } = controlledFetcher();
    const onState = vi.fn();
    const search = createPlayerSearch(fetcher, onState);
    const last = () => onState.mock.lastCall?.[0];
    return { fetcher, calls, onState, search, last };
  }

  it('waits for typing to pause before searching', async () => {
    const { fetcher, search } = setup();

    search.update('as');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1);
    expect(fetcher).not.toHaveBeenCalled();

    search.update('ash');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1);
    expect(fetcher).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('ash');
  });

  it('never searches for under two characters, and clears what was shown', async () => {
    const { fetcher, search, last } = setup();

    search.update(' a ');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2);

    expect(fetcher).not.toHaveBeenCalled();
    expect(last()).toEqual({ status: 'idle' });
  });

  it('shows the results of the search', async () => {
    const { calls, search, last } = setup();

    search.update('ash');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    expect(last()).toEqual({ status: 'loading' });
    calls[0]!.resolve(['0011']);
    await vi.advanceTimersByTimeAsync(0);

    expect(last()).toEqual({ status: 'done', results: ['0011'] });
  });

  it('ignores a slow older response that lands after the newer one', async () => {
    const { calls, search, last } = setup();

    search.update('as');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    search.update('ash');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

    calls[1]!.resolve(['ash result']);
    await vi.advanceTimersByTimeAsync(0);
    calls[0]!.resolve(['as result']);
    await vi.advanceTimersByTimeAsync(0);

    expect(last()).toEqual({ status: 'done', results: ['ash result'] });
  });

  it('ignores a response for a search that was cleared while it was in flight', async () => {
    const { calls, search, last } = setup();

    search.update('ash');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    search.update('');
    calls[0]!.resolve(['0011']);
    await vi.advanceTimersByTimeAsync(0);

    expect(last()).toEqual({ status: 'idle' });
  });

  it('reports a failed search once, without throwing', async () => {
    const { calls, search, last } = setup();

    search.update('ash');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    calls[0]!.reject(new Error('500'));
    await vi.advanceTimersByTimeAsync(0);

    expect(last()).toEqual({ status: 'error' });
  });

  it('a stale failure does not replace newer results', async () => {
    const { calls, search, last } = setup();

    search.update('as');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    search.update('ash');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    calls[1]!.resolve(['ash result']);
    await vi.advanceTimersByTimeAsync(0);
    calls[0]!.reject(new Error('500'));
    await vi.advanceTimersByTimeAsync(0);

    expect(last()).toEqual({ status: 'done', results: ['ash result'] });
  });

  it('reset drops a pending search and any in-flight response', async () => {
    const { fetcher, calls, search, last } = setup();

    search.update('ash');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    search.update('ashl');
    search.reset();
    calls[0]!.resolve(['0011']);
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(last()).toEqual({ status: 'idle' });
  });
});
