import { enforceRateLimit } from '@towerism/selfhost-kit/nitro';
import { InviteAcceptBody } from '#shared/schemas/professors';

/**
 * Public (ADR-0015 §6, §8): accepts an invite (a new professor) or a reset link (a new password), then signs them in.
 * Limited per client before the body is read, so a refused attempt costs no scrypt work.
 */
export default defineEventHandler(async (event) => {
  enforceRateLimit(event, inviteRateLimit('accept'));
  await refuseSignedIn(event);
  const body = await readValidatedBody(event, InviteAcceptBody.parse);
  try {
    const user = await useInvites().accept(body);
    await setUserSession(event, { user, loggedInAt: Date.now() });
    setResponseStatus(event, 201);
    return { user };
  } catch (err) {
    accountsHttpError(err);
  }
});
