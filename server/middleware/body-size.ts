/**
 * Request size limit (architecture §9): an `/api` body over 2 MiB is refused
 * by its `Content-Length` before it is read. The TDF preview route has its
 * own, larger limit (and its own 411/413), so it is left alone here.
 */
const MAX_BYTES = 2 * 1024 * 1024;
const WITH_BODY = new Set(['POST', 'PUT', 'PATCH']);
const TDF_PREVIEW = /^\/api\/sessions\/[^/]+\/tdf\/?(?:\?|$)/;

export default defineEventHandler((event) => {
  if (!WITH_BODY.has(event.method) || !event.path.startsWith('/api/') || TDF_PREVIEW.test(event.path)) return;
  const length = Number(getRequestHeader(event, 'content-length'));
  if (length > MAX_BYTES) throw createError({ statusCode: 413, message: 'The request is too large.' });
});
