import { describe, expect, it } from 'vitest';
import { maskedRequestLine, profileReport } from './profile';

describe('maskedRequestLine', () => {
  it('prints the request with the account id masked, so the output stays pasteable', () => {
    const sub = 'dcadf76c3a58ece3e84301fc988b83e5';
    expect(maskedRequestLine('GET', `/services/core/users/${sub}/activity_groups/?page=1`, 200, [sub])).toBe(
      'GET /services/core/users/<sub>/activity_groups/?page=1 → 200',
    );
  });
});

describe('profileReport', () => {
  it('lists every leaf path with its type and never prints a value', () => {
    const lines = profileReport('me', { guid: 'abc-123', consent_age: 18, meta: { verified: true }, mailing_address: null });
    expect(lines).toEqual(['me.guid: string(7)', 'me.consent_age: number', 'me.meta.verified: boolean', 'me.mailing_address: null']);
    expect(lines.join('\n')).not.toMatch(/abc-123|18/);
  });

  it('shows only the first letter and length of name-like fields', () => {
    const lines = profileReport('id_token', { given_name: 'Ash', family_name: 'Ketchum', screen_name: 'ashk' });
    expect(lines).toEqual([
      'id_token.given_name: name "A…" (3 chars)',
      'id_token.family_name: name "K…" (7 chars)',
      'id_token.screen_name: name "a…" (4 chars)',
    ]);
  });

  it('walks nested objects and the first item of arrays', () => {
    const lines = profileReport('me', { organized_play: { profiles: [{ player_id: '0012345', display_name: 'Ash K' }, { player_id: '9' }] } });
    expect(lines).toEqual([
      'me.organized_play.profiles: array(2)',
      'me.organized_play.profiles[0].player_id: string(7)',
      'me.organized_play.profiles[0].display_name: name "A…" (5 chars)',
    ]);
  });

  it('says so when the body is not an object', () => {
    expect(profileReport('me', 'oops')).toEqual(['me: string(4)']);
    expect(profileReport('me', undefined)).toEqual(['me: undefined']);
  });
});
