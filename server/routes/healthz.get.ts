/** Liveness for the image HEALTHCHECK: the process is serving HTTP. */
export default defineEventHandler(() => ({ status: 'ok' }));
