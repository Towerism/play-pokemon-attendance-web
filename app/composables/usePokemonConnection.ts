import type { ConnectionsResponse } from '~/utils/pokemon-connections';

/** The professors' Pokémon connections and the league's binding, shared by the layout banner, Settings and This week under one key. */
export function usePokemonConnection(opts: { immediate?: boolean } = {}) {
  // Explicit type: inferring this route's response trips vue-tsc's recursion limit.
  return useFetch<ConnectionsResponse>('/api/pokemon/connections', { key: 'pokemon-connection', immediate: opts.immediate ?? true });
}

export const refreshPokemonConnection = () => refreshNuxtData('pokemon-connection');
