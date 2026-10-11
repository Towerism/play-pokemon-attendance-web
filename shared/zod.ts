import { z } from 'zod';

/**
 * Zod for code that also runs in the browser. Zod 4 compiles object
 * validators with `new Function` when it may, and finds out by calling
 * `Function('')` the first time an object schema is built. Under the app's
 * CSP (no `unsafe-eval`, architecture §9) the browser refuses and reports a
 * violation on every page load. Jitless mode skips the probe; it has to be set
 * before the first schema is built, so app and shared code import `z` from
 * here, never from 'zod' (enforced by eslint.config.mjs).
 */
z.config({ jitless: true });

export { z };
