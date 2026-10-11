import { DEFAULT_LEAGUE_ID } from '../../modules/leagues';

/**
 * Hourly refresh-token keep-alive (ADR-0003), scheduled in nuxt.config.ts.
 * Rotates the token when the last refresh is ≥ 45 min old, so the chain never
 * ages out during a week off. Logs outcomes only, never tokens.
 */
export default defineTask({
  meta: { name: 'pokemon:keepalive', description: 'Refresh the Pokémon token so the connection never ages out' },
  async run() {
    const result = await usePokemon().keepAlive(DEFAULT_LEAGUE_ID);
    const log = useLogger('pokemon', { outcome: result.outcome });
    if (result.outcome === 'failed') log.warn(`Keep-alive failed: ${result.message}`);
    else if (result.outcome === 'needs_reconnect') log.warn('Keep-alive: the Pokémon account needs a reconnect (see Settings).');
    else log.info(`Keep-alive: ${result.outcome}`);
    return { result };
  },
});
