import { MintResetBody, ProfessorIdParam } from '#shared/schemas/professors';

/** Mint a password reset link for a professor (ADR-0015 §8), to copy or to send by Discord to their own connection. */
export default defineEventHandler(async (event) => {
  const { actor } = await requireOwner(event);
  const { userId } = await getValidatedRouterParams(event, ProfessorIdParam.parse);
  const { send } = await readValidatedBody(event, MintResetBody.parse);
  setResponseHeader(event, 'Cache-Control', 'no-store');
  try {
    const minted = await useInvites().mintReset(actor, userId, send);
    setResponseStatus(event, minted.invite.delivery === 'sending' ? 202 : 201);
    return minted;
  } catch (err) {
    accountsHttpError(err);
  }
});
