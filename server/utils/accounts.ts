import { type AccountsService, createAccountsService } from '../modules/accounts/service';
import { generateSetupCode } from '../modules/accounts/setup-code';

let accounts: AccountsService | undefined;

/** The accounts service, created on boot by the `database` plugin. */
export function useAccounts(): AccountsService {
  if (!accounts) {
    // A fresh code per boot. It only works while no account exists, so it is
    // printed only then: whoever can read the container log claims the install (ADR-0006).
    const setupCode = generateSetupCode();
    accounts = createAccountsService({ db: useDb(), hasher: scrypt, setupCode });
    if (accounts.needsSetup()) {
      console.log(`[setup] No organizer account yet. Open the app and enter this setup code: ${setupCode}`);
    }
  }
  return accounts;
}

const scrypt = {
  hash: (password: string) => hashPassword(password),
  verify: (hash: string, password: string) => verifyPassword(hash, password),
};
