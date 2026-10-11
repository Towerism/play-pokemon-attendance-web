/** Shorter searches match too much to be useful (and every 1-digit ID). */
export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_DEBOUNCE_MS = 250;
export const SEARCH_LIMIT = 20;

/** What to search for, or `undefined` when what was typed is too short. */
export function playerSearchTerm(typed: string): string | undefined {
  const term = typed.trim();
  return term.length >= SEARCH_MIN_LENGTH ? term : undefined;
}

export type SearchResultStatus = 'addable' | 'regular' | 'alreadyAdded';

export interface SearchResult {
  playerId: string;
  displayName: string;
  status: SearchResultStatus;
}

/** Tags each found player: regulars and players already in the session can't be added. */
export function toSearchResults(
  players: readonly { playerId: string; displayName: string; isRegular: boolean }[],
  sessionPlayerIds: ReadonlySet<string>,
): SearchResult[] {
  return players.map(({ playerId, displayName, isRegular }) => ({
    playerId,
    displayName,
    status: isRegular ? 'regular' : sessionPlayerIds.has(playerId) ? 'alreadyAdded' : 'addable',
  }));
}

export type PlayerSearchState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; results: T }
  | { status: 'error' };

/**
 * Search-as-you-type: debounces `update`, skips terms that are too short, and
 * reports only the newest search's outcome, so a slow older response never
 * replaces newer results.
 */
export function createPlayerSearch<T>(fetcher: (term: string) => Promise<T>, onState: (state: PlayerSearchState<T>) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;

  function reset() {
    clearTimeout(timer);
    generation++;
    onState({ status: 'idle' });
  }

  function update(typed: string) {
    const term = playerSearchTerm(typed);
    reset();
    if (!term) return;
    const mine = generation;
    timer = setTimeout(async () => {
      onState({ status: 'loading' });
      try {
        const results = await fetcher(term);
        if (mine === generation) onState({ status: 'done', results });
      } catch {
        if (mine === generation) onState({ status: 'error' });
      }
    }, SEARCH_DEBOUNCE_MS);
  }

  return { update, reset };
}
