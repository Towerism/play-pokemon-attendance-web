import { MintInviteBody } from '#shared/schemas/professors';

/**
 * Mint an invite (ADR-0015 §6). Copy: 201 with the secret, the only time it is returned. Send by Discord: 201 once
 * Genie delivered it, 202 while it is still sending, 422 when Genie refused it (the invite is revoked).
 */
export default defineEventHandler(async (event) => {
  const { actor } = await requireOwner(event);
  const body = await readValidatedBody(event, MintInviteBody.parse);
  setResponseHeader(event, 'Cache-Control', 'no-store');
  try {
    const minted = await useInvites().mint(actor, body);
    setResponseStatus(event, minted.invite.delivery === 'sending' ? 202 : 201);
    return minted;
  } catch (err) {
    accountsHttpError(err);
  }
});
