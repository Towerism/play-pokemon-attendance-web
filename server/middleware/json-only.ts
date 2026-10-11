/**
 * CSRF guard (architecture §9): a state-changing /api request that carries a
 * body must be JSON. Cross-site forms and no-cors fetches can only send
 * form, multipart or text bodies, so they are rejected before any handler runs.
 */
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export default defineEventHandler((event) => {
  if (!UNSAFE.has(event.method) || !event.path.startsWith('/api/')) return;
  const type = getRequestHeader(event, 'content-type');
  if (type && !/^application\/json\b/i.test(type)) {
    throw createError({ statusCode: 415, message: 'Send JSON (Content-Type: application/json)' });
  }
});
