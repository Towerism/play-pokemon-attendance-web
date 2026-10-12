interface Presence {
  present: boolean;
  inTournament: boolean;
}

/**
 * The session with one regular's presence replaced. `useFetch` data is a shallow ref,
 * so the page swaps in this copy instead of changing the row in place.
 */
export function withRegularPresence<R extends { playerId: string } & Presence, S extends { regulars: R[] }>(
  session: S,
  playerId: string,
  presence: Partial<Presence>,
): S {
  if (!session.regulars.some((r) => r.playerId === playerId)) return session;
  return { ...session, regulars: session.regulars.map((r) => (r.playerId === playerId ? { ...r, ...presence } : r)) };
}

/**
 * The players list with one player's regular flag replaced. `useAsyncData` data is a
 * shallow ref, so the page swaps in this copy instead of changing the row in place.
 */
export function withPlayerRegular<P extends { playerId: string; isRegular: boolean }, L extends { players: P[] }>(
  list: L,
  playerId: string,
  isRegular: boolean,
): L {
  if (!list.players.some((p) => p.playerId === playerId)) return list;
  return { ...list, players: list.players.map((p) => (p.playerId === playerId ? { ...p, isRegular } : p)) };
}
