import { describe, expect, it } from 'vitest';
import { ConnectCompleteBody, ProfessorParams, ProfessorQuery } from './pokemon';

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
