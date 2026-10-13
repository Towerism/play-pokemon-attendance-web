import { describe, expect, it } from 'vitest';
import { parseBearer } from './bearer';

const TOKEN = 'ppa_int_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCd';

describe('parseBearer', () => {
  it.each([
    [`Bearer ${TOKEN}`, TOKEN],
    [`bearer ${TOKEN}`, TOKEN],
    [`BEARER ${TOKEN}`, TOKEN],
    [`Bearer   ${TOKEN}`, TOKEN],
    [` Bearer ${TOKEN} `, TOKEN],
  ])('reads the token from %j', (header, token) => {
    expect(parseBearer(header)).toBe(token);
  });

  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['the scheme alone', 'Bearer'],
    ['the scheme and a space', 'Bearer '],
    ['another scheme', `Basic ${TOKEN}`],
    ['two credentials', `Bearer ${TOKEN} ${TOKEN}`],
    ['no space after the scheme', `Bearer${TOKEN}`],
    ['a bare token', TOKEN],
  ])('finds no token in %s', (_label, header) => {
    expect(parseBearer(header)).toBeNull();
  });
});
