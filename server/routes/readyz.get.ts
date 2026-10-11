/** Readiness: the database answers. */
export default defineEventHandler((event) => {
  try {
    useDatabase().sqlite.prepare('select 1').get();
    return { status: 'ready' };
  } catch {
    setResponseStatus(event, 503);
    return { status: 'unavailable' };
  }
});
