import type { H3Event } from 'h3';
import { InviteError, type InviteErrorCode, type InviteService, createInviteService } from '../modules/accounts/invites';
import { type ProfessorsService, createProfessorsService } from '../modules/accounts/professors';
import { type AccountsService, createAccountsService } from '../modules/accounts/service';
import { DEFAULT_LEAGUE_ID } from '../modules/leagues';
import { generateSetupCode } from '@towerism/selfhost-kit';

let accounts: AccountsService | undefined;
let invites: InviteService | undefined;
let professors: ProfessorsService | undefined;
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
    useLogger('setup').info(`No organizer account yet. Open the app and enter this setup code: ${setupCode}`);
  }
}

/**
 * Invites and password reset links (ADR-0015 §6, §8). Created at boot by the `messaging` plugin, so its handler for
 * Genie's results is registered before results recorded before a restart are replayed.
 */
export function useInvites(): InviteService {
  if (!invites) {
    const config = useRuntimeConfig();
    invites = createInviteService({
      db: useDb(),
      hasher: scrypt,
      channel: useMessaging(),
      connections: { ownerConnectionCount: () => usePokemon().ownerConnectionCount(), recipientOf: (id) => usePokemon().recipientOf(id) },
      leagueId: DEFAULT_LEAGUE_ID,
      leagueName: () => usePokemon().league(DEFAULT_LEAGUE_ID)?.name ?? null,
      timeZone: leagueTimeZone(),
      siteUrl: config.public.siteUrl || null,
      sendWaitMs: Number(config.messaging.sendWaitMs),
      log: useLogger('accounts'),
    });
  }
  return invites;
}

/** Settings → Professors (ADR-0015 §8). */
export function useProfessors(): ProfessorsService {
  professors ??= createProfessorsService({ db: useDb(), invites: useInvites(), connections: usePokemon(), channel: useMessaging(), log: useLogger('accounts') });
  return professors;
}

const INVITE_STATUS: Record<InviteErrorCode, number> = {
  invite_limit: 409,
  invite_invalid: 404,
  invite_used: 409,
  invite_not_found: 404,
  username_taken: 409,
  username_required: 400,
  professor_not_found: 404,
  no_recipient: 409,
  site_url_not_set: 409,
  no_discord_user: 422,
  dm_refused: 422,
  undeliverable: 422,
};

/** Maps invite, messaging and Pokémon errors to HTTP with `data.code`; anything else is rethrown. */
export function accountsHttpError(err: unknown): never {
  if (err instanceof InviteError) throw createError({ statusCode: INVITE_STATUS[err.code], message: err.message, data: { code: err.code } });
  return messagingHttpError(err);
}

/** The public invite routes refuse a browser that is already signed in (ADR-0015 §6), before reading the invite. */
export async function refuseSignedIn(event: H3Event): Promise<void> {
  const { user } = await getUserSession(event);
  if (user) {
    throw createError({ statusCode: 409, message: "You're already signed in. Log out to use this link.", data: { code: 'already_signed_in' } });
  }
}

const scrypt = {
  hash: (password: string) => hashPassword(password),
  verify: (hash: string, password: string) => verifyPassword(hash, password),
};
