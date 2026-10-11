/** Public: tells the login page whether to show first-run setup instead. */
export default defineEventHandler(() => {
  const needsSetup = useAccounts().needsSetup();
  // Re-print the code now, when someone is about to type it in.
  if (needsSetup) announceSetupCode();
  return { needsSetup };
});
