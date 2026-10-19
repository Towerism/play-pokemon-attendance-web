import { describe, expect, it } from 'vitest';
import { INVALID_LINK, secretFromHash, signedInText } from './invite';

describe('secretFromHash (the /invite page reads its secret from the URL fragment)', () => {
  it('takes what follows the #', () => {
    expect(secretFromHash('#ppa_inv_AbC-_1')).toBe('ppa_inv_AbC-_1');
    expect(secretFromHash('#%20ppa_inv_x%20')).toBe('ppa_inv_x');
  });

  it('is null with no fragment, or an empty one', () => {
    expect(secretFromHash('')).toBeNull();
    expect(secretFromHash('#')).toBeNull();
    expect(secretFromHash('#%E0%A4%A')).toBeNull();
  });
});

describe('what the page says', () => {
  it('to a browser that is signed in, and for a link that no longer works', () => {
    expect(signedInText('organizer')).toBe("You're signed in as organizer. Log out to use this link.");
    expect(INVALID_LINK).toBe("This link doesn't work. It may have expired, been used or been revoked. Ask the league's owner for a new one.");
  });
});
