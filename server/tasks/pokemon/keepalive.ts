/**
 * Hourly refresh-token keep-alive (ADR-0003, ADR-0008), scheduled in
 * nuxt.config.ts. Rotates each professor's token when its last refresh is
 * ≥ 45 min old, one connection at a time, so no chain ages out during a week
 * off. Logs one outcome per professor, never tokens.
 */
export default defineTask({
  meta: { name: 'pokemon:keepalive', description: "Refresh each professor's Pokémon token so no connection ages out" },
  async run() {
    const result = await usePokemon().keepAliveAll();
    for (const r of result) {
      const professor = r.professorPlayerId ?? `connection ${r.connectionId}`;
      const log = useLogger('pokemon', { outcome: r.outcome, professor });
      if (r.outcome === 'failed') log.warn(`Keep-alive failed for professor ${professor}: ${r.message}`);
      else if (r.outcome === 'needs_reconnect') log.warn(`Keep-alive: professor ${professor}'s Pokémon account needs a reconnect (see Settings).`);
      else log.info(`Keep-alive for professor ${professor}: ${r.outcome}`);
    }
    return { result };
  },
});
