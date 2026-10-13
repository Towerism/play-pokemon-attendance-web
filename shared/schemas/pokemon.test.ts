import { describe, expect, it } from 'vitest';
import { ConnectCompleteBody, ProfessorNamesBody, ProfessorParams, ProfessorQuery } from './pokemon';

describe('ProfessorNamesBody: the display name (display only)', () => {
  it('trims the name and takes up to 60 characters', () => {
    expect(ProfessorNamesBody.parse({ name: '  Brock Harrison  ' })).toEqual({ name: 'Brock Harrison' });
    expect(ProfessorNamesBody.parse({ name: 'a'.repeat(60) })).toEqual({ name: 'a'.repeat(60) });
  });

  it('clears the name with an empty string, blanks or null', () => {
    expect(ProfessorNamesBody.parse({ name: '' })).toEqual({ name: null });
    expect(ProfessorNamesBody.parse({ name: '   ' })).toEqual({ name: null });
    expect(ProfessorNamesBody.parse({ name: null })).toEqual({ name: null });
  });

  it.each([
    ['61 characters', { name: 'a'.repeat(61) }],
    ['a control character', { name: 'Brock\u0007' }],
    ['a newline', { name: 'Brock\nHarrison' }],
    ['a number', { name: 42 }],
  ])('rejects a name that is %s', (_l, body) => {
    expect(ProfessorNamesBody.safeParse(body).success).toBe(false);
  });
});

describe('ProfessorNamesBody: the full name for TDFs', () => {
  it('trims the full name and takes up to 100 characters, leaving the display name out', () => {
    expect(ProfessorNamesBody.parse({ fullName: '  Brock Harrison  ' })).toEqual({ fullName: 'Brock Harrison' });
    expect(ProfessorNamesBody.parse({ fullName: 'a'.repeat(100) })).toEqual({ fullName: 'a'.repeat(100) });
  });

  it('clears the full name with an empty string, blanks or null', () => {
    expect(ProfessorNamesBody.parse({ fullName: '' })).toEqual({ fullName: null });
    expect(ProfessorNamesBody.parse({ fullName: '   ' })).toEqual({ fullName: null });
    expect(ProfessorNamesBody.parse({ fullName: null })).toEqual({ fullName: null });
  });

  it('keeps accents, apostrophes and markup-looking text exactly; escaping is for whoever writes the TDF', () => {
    expect(ProfessorNamesBody.parse({ fullName: 'José Ñúñez' })).toEqual({ fullName: 'José Ñúñez' });
    expect(ProfessorNamesBody.parse({ fullName: "O'Brien & <Co>" })).toEqual({ fullName: "O'Brien & <Co>" });
  });

  it('takes both names at once', () => {
    expect(ProfessorNamesBody.parse({ name: 'Brock', fullName: 'Brock Harrison' })).toEqual({ name: 'Brock', fullName: 'Brock Harrison' });
  });

  it.each([
    ['101 characters', { fullName: 'a'.repeat(101) }],
    ['a control character', { fullName: 'Brock\u0000' }],
    ['a newline', { fullName: 'Brock\nHarrison' }],
    ['a number', { fullName: 42 }],
  ])('rejects a full name that is %s', (_l, body) => {
    expect(ProfessorNamesBody.safeParse(body).success).toBe(false);
  });

  it('rejects a body with neither name', () => {
    expect(ProfessorNamesBody.safeParse({}).success).toBe(false);
  });

  it('rejects a valid full name sent with an invalid display name', () => {
    expect(ProfessorNamesBody.safeParse({ name: 'a'.repeat(61), fullName: 'Brock Harrison' }).success).toBe(false);
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
