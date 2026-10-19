/** The `/invite` page (ADR-0015 §6): the secret travels in the URL fragment, so browsers never send it to a server. */

export const INVALID_LINK = "This link doesn't work. It may have expired, been used or been revoked. Ask the league's owner for a new one.";

/** The secret after the `#`, or null when there is none (or it isn't valid percent-encoding). */
export function secretFromHash(hash: string): string | null {
  try {
    const secret = decodeURIComponent(hash.replace(/^#/, '')).trim();
    return secret === '' ? null : secret;
  } catch {
    return null;
  }
}

export function signedInText(username: string): string {
  return `You're signed in as ${username}. Log out to use this link.`;
}
