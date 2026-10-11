import { SetupBody } from '#shared/schemas/auth';
import { InvalidSetupCodeError, SetupClosedError } from '../../modules/accounts/service';

/** First-run setup: create the organizer account with the logged setup code, then log in. */
export default defineEventHandler(async (event) => {
  enforceAuthRateLimit(event, 'setup');
  const body = await readValidatedBody(event, SetupBody.parse);
  try {
    const user = await useAccounts().setup(body);
    await setUserSession(event, { user, loggedInAt: Date.now() });
    return { user };
  } catch (err) {
    if (err instanceof SetupClosedError) throw createError({ statusCode: 409, message: err.message });
    if (err instanceof InvalidSetupCodeError) throw createError({ statusCode: 403, message: err.message });
    throw err;
  }
});
