import { type CardLease, LeaseError, type LeaseErrorCode, type LeaseService, type LeaseStore, createLeaseService, createLeaseStore } from '../modules/pokemon/leases';

let store: LeaseStore | undefined;
let leases: LeaseService | undefined;

/** The lease table's reads and writes (ADR-0015 §5), shared by the connection service and the lease service. */
export function useLeaseStore(): LeaseStore {
  store ??= createLeaseStore({ db: useDb() });
  return store;
}

/**
 * Tournament leases (ADR-0015 §5). Created at boot by the `messaging` plugin, so its handler for Genie's results is
 * registered before results recorded before a restart are replayed.
 */
export function useLeases(): LeaseService {
  if (!leases) {
    const config = useRuntimeConfig();
    leases = createLeaseService({
      db: useDb(),
      store: useLeaseStore(),
      connections: usePokemon(),
      accounts: useAccounts(),
      gateway: (connectionId) => connectionGateway(connectionId),
      channel: useMessaging(),
      timeZone: leagueTimeZone(),
      siteUrl: () => config.public.siteUrl || null,
      log: useLogger('leases'),
    });
  }
  return leases;
}

const STATUS: Record<LeaseErrorCode, number> = {
  lessee_is_you: 400,
  ends_at_invalid: 400,
  lessee_not_member: 409,
  lease_refused: 409,
  league_not_selected: 409,
  lease_not_found: 404,
};

/** Maps lease errors to HTTP with `data.code` (and a grant's `refusals`); Pokémon errors as the other routes do. */
export function leasesHttpError(err: unknown): never {
  if (err instanceof LeaseError) {
    throw createError({ statusCode: STATUS[err.code], message: err.message, data: { code: err.code, ...(err.data ?? {}) } });
  }
  return pokemonHttpError(err);
}

/**
 * Adds each tournament's live lease to a card view, from local rows on every request (ADR-0015 §5), so a grant or an
 * ending shows at once, even on answers served from the tournaments module's listing cache.
 */
export function withCardLeases<T extends { tournamentId: string | null }>(items: readonly T[]): (T & { lease: CardLease | null })[] {
  const live = useLeases().leasesFor(items.flatMap((i) => (i.tournamentId ? [i.tournamentId] : [])));
  return items.map((i) => ({ ...i, lease: (i.tournamentId && live.get(i.tournamentId)) || null }));
}
