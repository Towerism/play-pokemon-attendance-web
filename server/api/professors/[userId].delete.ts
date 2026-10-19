import { ProfessorIdParam } from '#shared/schemas/professors';

/** Remove a professor (ADR-0015 §8): their access ends on their next request, and their Pokémon connection goes. */
export default defineEventHandler(async (event) => {
  await requireOwner(event);
  const { userId } = await getValidatedRouterParams(event, ProfessorIdParam.parse);
  try {
    await useProfessors().remove(userId);
  } catch (err) {
    accountsHttpError(err);
  }
  setResponseStatus(event, 204);
  return null;
});
