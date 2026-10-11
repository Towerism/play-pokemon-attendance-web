import { describe, expect, it } from 'vitest';
import { ConnectCompleteBody } from './pokemon';

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
