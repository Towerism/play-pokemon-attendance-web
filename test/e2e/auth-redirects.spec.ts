import { OWNER, createOrganizer, expect, logIn, test } from './fixtures';

// The login wall as the browser meets it: `authRedirect` is unit-tested; this
// checks its wiring through the global middleware, SSR and hydration.

test('the login wall sends people back where they were going, and never off-site', async ({ page, app }) => {
  await createOrganizer(app);

  // A logged-out deep link goes to login, and comes back after it.
  await page.goto('/history');
  await expect(page).toHaveURL(/\/login\?redirect=(\/|%2F)history$/);
  await logIn(page, OWNER);
  await expect(page).toHaveURL(/\/history$/);

  // Logging out ends on login, and the app is walled off again.
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);

  // A redirect to another site lands on the app home instead.
  await page.goto('/login?redirect=//evil.example');
  await logIn(page, OWNER);
  await expect(page).toHaveURL(`${app.url}/`);
});
