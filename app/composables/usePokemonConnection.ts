/** Pokémon connection status, shared by the layout banner and Settings under one key. */
export function usePokemonConnection(opts: { immediate?: boolean } = {}) {
  return useFetch('/api/pokemon/connection', { key: 'pokemon-connection', immediate: opts.immediate ?? true });
}

export const refreshPokemonConnection = () => refreshNuxtData('pokemon-connection');
