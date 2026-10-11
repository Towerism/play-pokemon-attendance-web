import { type AccountsService, createAccountsService } from '../modules/accounts/service';
import { generateSetupCode } from '../modules/accounts/setup-code';

let accounts: AccountsService | undefined;
// A fresh code per boot. It only works while no account exists (ADR-0006).
const setupCode = generateSetupCode();

/** The accounts service, created on boot by the `database` plugin. */
export function useAccounts(): AccountsService {
  accounts ??= createAccountsService({ db: useDb(), hasher: scrypt, setupCode });
  return accounts;
}

/**
 * Prints the setup code while no account exists: whoever can read the
 * container log can claim the install. Called on boot and again whenever the
 * setup page opens, so the code is at the bottom of a long log.
 */
export function announceSetupCode(): void {
  if (useAccounts().needsSetup()) {
    console.log(`[setup] No organizer account yet. Open the app and enter this setup code: ${setupCode}`);
  }
}

const scrypt = {
  hash: (password: string) => hashPassword(password),
  verify: (hash: string, password: string) => verifyPassword(hash, password),
};
