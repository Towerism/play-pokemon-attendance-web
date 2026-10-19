/**
 * The Discord channel at boot and shutdown (ADR-0015 §7).
 *
 * Boot: the invite service registers its handler for Genie's results, then every final result whose handler hadn't run
 * before a crash is handed to it, so an invite Genie refused can't stay live.
 *
 * Shutdown: Nitro calls `close` only after open connections finish, and a long poll may wait 25 s, longer than the
 * 8-second stop. So the channel listens for the shutdown signals itself: on the first one, waiting polls answer empty
 * and waiting sends answer "still sending" at once. `close` drains too, in case no signal arrived.
 */
export default defineNitroPlugin((nitroApp) => {
  const messaging = useMessaging();
  useInvites();
  const replayed = messaging.replayUnhandled();
  if (replayed > 0) useLogger('messaging').info(`Handed ${replayed} delivery result(s) recorded before a restart to their senders.`, { replayed });

  const signals = (process.env.NITRO_SHUTDOWN_SIGNALS || 'SIGTERM SIGINT').split(' ').filter(Boolean);
  for (const signal of signals) process.once(signal, () => messaging.drain());
  nitroApp.hooks.hook('close', () => messaging.drain());
});
