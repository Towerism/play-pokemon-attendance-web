import { LoginBody } from '#shared/schemas/auth';

export default defineEventHandler(async (event) => {
  enforceAuthRateLimit(event, 'login');
  const body = await readValidatedBody(event, LoginBody.parse);
  const user = await useAccounts().authenticate(body);
  if (!user) throw createError({ statusCode: 401, message: 'Wrong username or password' });

  await setUserSession(event, { user, loggedInAt: Date.now() });
  return { user };
});
