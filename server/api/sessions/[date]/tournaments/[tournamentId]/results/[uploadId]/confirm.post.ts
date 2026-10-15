import { ResultsConfirmBody, ResultsUploadParams } from '#shared/schemas/results';

/**
 * **Upload results** / **Upload anyway** (ADR-0011 decision 4): `acknowledgedWarnings` must be the preview's warnings
 * fingerprint. 202 with a `tdf_upload` job that validates (the send: Pokémon support gets a copy) and confirms only if
 * play-tools accepts the file; follow `/api/submissions/{id}/events`.
 */
export default defineEventHandler(async (event) => {
  const leagueId = await requireLeague(event);
  const { user } = await requireUserSession(event);
  const { date, tournamentId, uploadId } = await getValidatedRouterParams(event, ResultsUploadParams.parse);
  const body = await readValidatedBody(event, ResultsConfirmBody.parse);
  const started = await useSubmissions().uploadResults(leagueId, { date, tournamentId, uploadId, body, startedBy: user.username }).catch(resultsHttpError);
  setResponseStatus(event, 202);
  return started;
});
