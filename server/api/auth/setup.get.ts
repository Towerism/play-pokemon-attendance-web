/** Public: tells the login page whether to show first-run setup instead. */
export default defineEventHandler(() => ({ needsSetup: useAccounts().needsSetup() }));
