import { InviteIdParam } from '#shared/schemas/professors';

/** Revoke an invite or reset link until it is used; its Discord message, if still pending, is cancelled. */
export default defineEventHandler(async (event) => {
  await requireOwner(event);
  const { id } = await getValidatedRouterParams(event, InviteIdParam.parse);
  try {
    useInvites().revoke(id);
  } catch (err) {
    accountsHttpError(err);
  }
  setResponseStatus(event, 204);
  return null;
});
