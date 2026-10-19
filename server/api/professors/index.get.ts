/** Settings → Professors (ADR-0015 §8): professors, open invites, seats and Genie. Never a secret, hash or token. */
export default defineEventHandler(async (event) => {
  await requireOwner(event);
  setResponseHeader(event, 'Cache-Control', 'no-store');
  return useProfessors().list();
});
