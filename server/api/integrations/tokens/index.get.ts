/** The league's integration tokens, newest first: never a secret or hash. */
export default defineEventHandler(async (event) => {
  const { leagueId } = await requireOwner(event);
  setResponseHeader(event, 'Cache-Control', 'no-store');
  return { tokens: useIntegrationTokens().list(leagueId) };
});
