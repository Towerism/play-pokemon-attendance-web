import { enforceRateLimit } from '@towerism/selfhost-kit/nitro';
import { LoginBody } from '#shared/schemas/auth';

export default defineEventHandler(async (event) => {
  enforceRateLimit(event, authRateLimit('login'));
  const body = await readValidatedBody(event, LoginBody.parse);
  const user = await useAccounts().authenticate(body);
  if (!user) throw createError({ statusCode: 401, message: 'Wrong username or password' });

  await setUserSession(event, { user, loggedInAt: Date.now() });
  return { user };
});
