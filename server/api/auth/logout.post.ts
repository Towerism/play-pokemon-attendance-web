export default defineEventHandler(async (event) => {
  await clearUserSession(event);
  setResponseStatus(event, 204);
  return null;
});
