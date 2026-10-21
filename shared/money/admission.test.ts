import { describe, expect, it } from 'vitest';
import { admissionText, formatAdmission, parseAdmission } from './admission';

describe('parseAdmission', () => {
  it.each([
    ['10', 1000],
    ['$10', 1000],
    [' 7.5 ', 750],
    ['7.50', 750],
    ['$0', 0],
    ['FREE', 0],
    ['free', 0],
    ['999.99', 99999],
  ])('reads %j as %i cents', (text, cents) => {
    expect(parseAdmission(text)).toBe(cents);
  });

  it.each(['10 dollars', '7.505', '-5', '1,000', 'abc', '', '1000.00', '$', '.5', '10.'])('reads %j as no amount', (text) => {
    expect(parseAdmission(text)).toBeNull();
  });

  it('reads null as no amount', () => {
    expect(parseAdmission(null)).toBeNull();
  });
});

describe('formatAdmission', () => {
  it.each([
    [0, 'Free'],
    [1000, '$10'],
    [750, '$7.50'],
    [5, '$0.05'],
    [99999, '$999.99'],
  ])('shows %i cents as %j', (cents, text) => {
    expect(formatAdmission(cents)).toBe(text);
  });

  it('shows no amount as nothing', () => {
    expect(formatAdmission(null)).toBeNull();
  });
});

describe('admissionText', () => {
  it.each([
    [0, 'Free'],
    [1000, '10'],
    [750, '7.50'],
    [5, '0.05'],
  ])('writes %i cents for play-tools as %j, which reads back as the same amount', (cents, text) => {
    expect(admissionText(cents)).toBe(text);
    expect(parseAdmission(text)).toBe(cents);
  });

  it('writes no amount as null', () => {
    expect(admissionText(null)).toBeNull();
  });
});
