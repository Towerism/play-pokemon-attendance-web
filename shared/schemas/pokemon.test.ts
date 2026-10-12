import { describe, expect, it } from 'vitest';
import { ConnectCompleteBody, ProfessorNameBody, ProfessorParams, ProfessorQuery } from './pokemon';

describe('ProfessorNameBody (display only)', () => {
  it('trims the name and takes up to 60 characters', () => {
    expect(ProfessorNameBody.parse({ name: '  Brock Harrison  ' })).toEqual({ name: 'Brock Harrison' });
    expect(ProfessorNameBody.parse({ name: 'a'.repeat(60) })).toEqual({ name: 'a'.repeat(60) });
  });

  it('clears the name with an empty string, blanks or null', () => {
    expect(ProfessorNameBody.parse({ name: '' })).toEqual({ name: null });
    expect(ProfessorNameBody.parse({ name: '   ' })).toEqual({ name: null });
    expect(ProfessorNameBody.parse({ name: null })).toEqual({ name: null });
  });

  it.each([
    ['61 characters', { name: 'a'.repeat(61) }],
    ['a control character', { name: 'Brock\u0007' }],
    ['a newline', { name: 'Brock\nHarrison' }],
    ['a number', { name: 42 }],
    ['missing', {}],
  ])('rejects a name that is %s', (_l, body) => {
    expect(ProfessorNameBody.safeParse(body).success).toBe(false);
  });
});

describe('ProfessorParams and ProfessorQuery', () => {
  it('take a 1–12 digit player id, leading zeros kept', () => {
    expect(ProfessorParams.parse({ playerId: '0012345' })).toEqual({ playerId: '0012345' });
    expect(ProfessorQuery.parse({ professor: '000000000001' })).toEqual({ professor: '000000000001' });
  });

  it.each([
    ['missing', {}],
    ['empty', { professor: '' }],
    ['not digits', { professor: '1 OR 1=1' }],
    ['13 digits', { professor: '1234567890123' }],
    ['given twice', { professor: ['1', '2'] }],
  ])('rejects a professor that is %s', (_l, query) => {
    expect(ProfessorQuery.safeParse(query).success).toBe(false);
  });

  it('rejects a path player id that is not digits', () => {
    expect(ProfessorParams.safeParse({ playerId: 'abc' }).success).toBe(false);
  });
});

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
