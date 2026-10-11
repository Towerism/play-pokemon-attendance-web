import { describe, expect, it } from 'vitest';
import { ConnectCompleteBody, SettingsBody } from './pokemon';

describe('ConnectCompleteBody', () => {
  it('trims the pasted address', () => {
    expect(ConnectCompleteBody.parse({ url: '  https://play-tools.pokemon.com/loggedIn?code=a&state=b \n' }).url).toBe(
      'https://play-tools.pokemon.com/loggedIn?code=a&state=b',
    );
  });

  it.each([
    ['missing', {}],
    ['empty', { url: '   ' }],
    ['not a string', { url: 42 }],
    ['over 4 KB', { url: `https://x/${'a'.repeat(4096)}` }],
  ])('rejects a url that is %s', (_l, body) => {
    expect(ConnectCompleteBody.safeParse(body).success).toBe(false);
  });
});

describe('SettingsBody', () => {
  it('takes the chosen activity group', () => {
    expect(SettingsBody.parse({ activityGroupId: ' 00000000-0000-4000-8000-000000000004 ' })).toEqual({
      activityGroupId: '00000000-0000-4000-8000-000000000004',
    });
  });

  it.each([
    ['missing', {}],
    ['empty', { activityGroupId: '' }],
    ['over 100 characters', { activityGroupId: 'a'.repeat(101) }],
  ])('rejects an activity group id that is %s', (_l, body) => {
    expect(SettingsBody.safeParse(body).success).toBe(false);
  });
});
