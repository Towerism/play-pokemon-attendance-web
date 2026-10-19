import { enforceRateLimit } from '@towerism/selfhost-kit/nitro';
import { InviteCheckBody } from '#shared/schemas/professors';

/**
 * Public (ADR-0015 §6): what an invite or reset link is for, for the `/invite` page. Limited per client before the body
 * is read; a signed-in browser is refused; every unusable secret gets the same 404.
 */
export default defineEventHandler(async (event) => {
  enforceRateLimit(event, inviteRateLimit('check'));
  await refuseSignedIn(event);
  const { secret } = await readValidatedBody(event, InviteCheckBody.parse);
  setResponseHeader(event, 'Cache-Control', 'no-store');
  try {
    return useInvites().check(secret);
  } catch (err) {
    accountsHttpError(err);
  }
});
