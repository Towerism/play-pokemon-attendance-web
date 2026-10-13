import { describe, expect, it } from 'vitest';
import { tomTdf } from './__fixtures__/tom';
import { correctTdf } from './correct';
import { TDF_MAX_BYTES, TdfError, type TdfErrorCode, parseTdf } from './parse';

const DISPLAY_ID = '26-10-000123';
const WRONG_ORGANIZER = '<organizer popid="1234500" name="Alex Example"/>';
const PAT = { playerId: '7654321', name: 'Pat Organizer' };
const PAT_ELEMENT = '<organizer popid="7654321" name="Pat Organizer"/>';

/**
 * The input with exactly one occurrence of `from` replaced by `to`, worked out independently of `correctTdf`.
 * `from` must occur once, so the expected file is unambiguous.
 */
function withOneEdit(input: string, from: string, to: string): string {
  const at = input.indexOf(from);
  expect(at, `${from} is in the fixture`).toBeGreaterThanOrEqual(0);
  expect(input.indexOf(from, at + 1), `${from} is in the fixture once`).toBe(-1);
  return input.slice(0, at) + to + input.slice(at + from.length);
}

describe('correctTdf: filling an empty tournament id', () => {
  it.each([['<id/>'], ['<id></id>'], ['<id>  \n </id>'], ['<id />']])('fills %j and changes nothing else', (idElement) => {
    const input = tomTdf({ idElement });

    const result = correctTdf(input, { tournamentId: DISPLAY_ID });

    expect(result.tournamentId).toEqual({ applied: true });
    expect(result.xml).toBe(withOneEdit(input, idElement, `<id>${DISPLAY_ID}</id>`));
    expect(parseTdf(result.xml).header.tournamentId).toBe(DISPLAY_ID);
  });

  it('never overwrites an id that is present, even a different one', () => {
    const input = tomTdf({ idElement: '<id>26-10-000999</id>' });

    const result = correctTdf(input, { tournamentId: DISPLAY_ID });

    expect(result).toEqual({ xml: input, tournamentId: { applied: false, reason: 'not_empty' } });
  });

  it.each([['26-10-123'], ['abc'], [`${DISPLAY_ID}x`], [''], [' 26-10-000123']])(
    'refuses the malformed display id %j',
    (tournamentId) => {
      const input = tomTdf({ idElement: '<id/>' });

      expect(correctTdf(input, { tournamentId })).toEqual({ xml: input, tournamentId: { applied: false, reason: 'invalid_value' } });
    },
  );

  it.each([
    ['no id element', ''],
    ['two id elements', '<id/><id/>'],
    ['an id holding an element', '<id><x/></id>'],
  ])('changes nothing when data has %s', (_label, idElement) => {
    const input = tomTdf({ idElement });

    expect(correctTdf(input, { tournamentId: DISPLAY_ID })).toEqual({
      xml: input,
      tournamentId: { applied: false, reason: 'unexpected_shape' },
    });
  });

  it('is left out of the result when only the organizer is asked for', () => {
    expect(correctTdf(tomTdf(), { organizer: PAT })).not.toHaveProperty('tournamentId');
  });

  it('only counts the id inside data: an id elsewhere is neither counted nor edited', () => {
    const input = tomTdf({ idElement: '<id/>' }).replace('<pods></pods>', '<pods><id/></pods>');

    const result = correctTdf(input, { tournamentId: DISPLAY_ID });

    expect(result.tournamentId).toEqual({ applied: true });
    expect(result.xml).toBe(withOneEdit(input, '    <id/>', `    <id>${DISPLAY_ID}</id>`));
  });
});

describe('correctTdf: replacing the organizer', () => {
  it('replaces only the popid and name values, and reports the organizer it replaced', () => {
    const input = tomTdf({ organizerElement: WRONG_ORGANIZER });

    const result = correctTdf(input, { organizer: PAT });

    expect(result.organizer).toEqual({ applied: true, previous: { playerId: '1234500', name: 'Alex Example' } });
    expect(result.xml).toBe(withOneEdit(input, WRONG_ORGANIZER, PAT_ELEMENT));
    expect(parseTdf(result.xml).header.organizer).toEqual(PAT);
  });

  it.each([
    ['an ampersand', 'Pat & Sam', 'Pat &amp; Sam'],
    ['angle brackets', 'Pat <Org>', 'Pat &lt;Org&gt;'],
    ['double quotes', 'Pat "PJ" Org', 'Pat &quot;PJ&quot; Org'],
    ['an apostrophe', "Pat O'Neil", 'Pat O&apos;Neil'],
    ['replacement patterns', 'Pat $& $1 $$', 'Pat $&amp; $1 $$'],
    ['accents', 'Zoë Ríos-Núñez', 'Zoë Ríos-Núñez'],
    ['an emoji', 'Pat 🐉 Org', 'Pat 🐉 Org'],
  ])('escapes a name with %s, and it reads back exactly', (_label, name, written) => {
    const input = tomTdf({ organizerElement: WRONG_ORGANIZER });

    const result = correctTdf(input, { organizer: { playerId: '7654321', name } });

    expect(result.xml).toBe(withOneEdit(input, WRONG_ORGANIZER, `<organizer popid="7654321" name="${written}"/>`));
    expect(parseTdf(result.xml).header.organizer).toEqual({ playerId: '7654321', name });
  });

  it('decodes the old name once when reporting it, and never double-escapes the new one', () => {
    const input = tomTdf({ organizerElement: '<organizer popid="1234500" name="Alex &amp; Co"/>' });

    const result = correctTdf(input, { organizer: { playerId: '7654321', name: 'Pat & Co' } });

    expect(result.organizer).toEqual({ applied: true, previous: { playerId: '1234500', name: 'Alex & Co' } });
    expect(result.xml).toContain('<organizer popid="7654321" name="Pat &amp; Co"/>');
  });

  it.each([
    ['name before popid', '<organizer name="Alex" popid="1234500"/>', '<organizer name="Pat Organizer" popid="7654321"/>'],
    ['single quotes', "<organizer popid='1234500' name='Alex'/>", "<organizer popid='7654321' name='Pat Organizer'/>"],
    [
      'extra attributes',
      '<organizer popid="1234500" extra="x" name="Alex" />',
      '<organizer popid="7654321" extra="x" name="Pat Organizer" />',
    ],
    ['a closing tag', '<organizer popid="1234500" name="Alex"></organizer>', '<organizer popid="7654321" name="Pat Organizer"></organizer>'],
    ['spaces around =', '<organizer popid = "1234500"  name ="Alex"/>', '<organizer popid = "7654321"  name ="Pat Organizer"/>'],
  ])('keeps the element as written when it has %s', (_label, organizerElement, expected) => {
    const input = tomTdf({ organizerElement });

    const result = correctTdf(input, { organizer: PAT });

    expect(result.organizer).toMatchObject({ applied: true });
    expect(result.xml).toBe(withOneEdit(input, organizerElement, expected));
  });

  it("replaces an organizer that already matches, since deciding to is the caller's job", () => {
    const input = tomTdf({ organizerElement: PAT_ELEMENT });

    expect(correctTdf(input, { organizer: PAT })).toEqual({ xml: input, organizer: { applied: true, previous: PAT } });
  });

  it.each([
    ['a player id with letters', { playerId: '76543a1', name: 'Pat' }],
    ['a 13-digit player id', { playerId: '1234567890123', name: 'Pat' }],
    ['an empty player id', { playerId: '', name: 'Pat' }],
    ['a blank name', { playerId: '7654321', name: '   ' }],
    ['a name over 100 characters', { playerId: '7654321', name: 'P'.repeat(101) }],
    ['a name with a control character', { playerId: '7654321', name: 'Pat\u0007Org' }],
    ['a name with a newline', { playerId: '7654321', name: 'Pat\nOrg' }],
  ])('refuses %s', (_label, organizer) => {
    const input = tomTdf({ organizerElement: WRONG_ORGANIZER });

    expect(correctTdf(input, { organizer })).toEqual({ xml: input, organizer: { applied: false, reason: 'invalid_value' } });
  });

  it('accepts a name of exactly 100 characters', () => {
    const name = 'P'.repeat(100);

    const result = correctTdf(tomTdf({ organizerElement: WRONG_ORGANIZER }), { organizer: { playerId: '7654321', name } });

    expect(parseTdf(result.xml).header.organizer?.name).toBe(name);
  });

  it.each([
    ['no organizer element', ''],
    ['two organizer elements', WRONG_ORGANIZER + WRONG_ORGANIZER],
    ['an organizer with no popid', '<organizer name="Alex"/>'],
    ['an organizer with no name', '<organizer popid="1234500"/>'],
  ])('changes nothing when data has %s', (_label, organizerElement) => {
    const input = tomTdf({ organizerElement });

    expect(correctTdf(input, { organizer: PAT })).toEqual({ xml: input, organizer: { applied: false, reason: 'unexpected_shape' } });
  });

  it('treats extra whitespace in the requested name as parseTdf does when re-checking', () => {
    const result = correctTdf(tomTdf({ organizerElement: WRONG_ORGANIZER }), { organizer: { playerId: '7654321', name: 'Pat  Organizer' } });

    expect(result.organizer).toMatchObject({ applied: true });
    expect(result.xml).toContain('name="Pat  Organizer"');
  });

  it('only edits the organizer inside data', () => {
    const input = tomTdf({ organizerElement: WRONG_ORGANIZER }).replace('<pods></pods>', '<pods><organizer popid="9" name="Z"/></pods>');

    const result = correctTdf(input, { organizer: PAT });

    expect(result.organizer).toMatchObject({ applied: true });
    expect(result.xml).toBe(withOneEdit(input, WRONG_ORGANIZER, PAT_ELEMENT));
  });
});

describe('correctTdf: both corrections', () => {
  it('fills the id and replaces the organizer, changing nothing else', () => {
    const input = tomTdf({ idElement: '<id/>', organizerElement: WRONG_ORGANIZER });

    const result = correctTdf(input, { tournamentId: DISPLAY_ID, organizer: PAT });

    expect(result).toEqual({
      xml: withOneEdit(withOneEdit(input, '<id/>', `<id>${DISPLAY_ID}</id>`), WRONG_ORGANIZER, PAT_ELEMENT),
      tournamentId: { applied: true },
      organizer: { applied: true, previous: { playerId: '1234500', name: 'Alex Example' } },
    });
  });

  it('still replaces the organizer when the id is already there', () => {
    const input = tomTdf({ idElement: '<id>26-10-000999</id>', organizerElement: WRONG_ORGANIZER });

    const result = correctTdf(input, { tournamentId: DISPLAY_ID, organizer: PAT });

    expect(result.tournamentId).toEqual({ applied: false, reason: 'not_empty' });
    expect(result.xml).toBe(withOneEdit(input, WRONG_ORGANIZER, PAT_ELEMENT));
  });

  it('keeps the byte-order mark, every CRLF and every birthdate as they were', () => {
    const input = tomTdf({ idElement: '<id/>', organizerElement: WRONG_ORGANIZER, eol: '\r\n', bom: true });

    const result = correctTdf(input, { tournamentId: DISPLAY_ID, organizer: PAT });

    expect(result.xml).toBe(withOneEdit(withOneEdit(input, '<id/>', `<id>${DISPLAY_ID}</id>`), WRONG_ORGANIZER, PAT_ELEMENT));
    expect(result.xml.startsWith('﻿<?xml')).toBe(true);
    expect(result.xml.split('\r\n')).toHaveLength(input.split('\r\n').length);
    expect(result.xml.match(/<birthdate>01\/02\/2012<\/birthdate>/g)).toHaveLength(2);
  });

  it('returns the input untouched when nothing is asked for', () => {
    const input = tomTdf({ idElement: '<id/>' });

    expect(correctTdf(input, {})).toEqual({ xml: input });
  });
});

describe('correctTdf: what it refuses to edit', () => {
  it.each<[string, string, TdfErrorCode]>([
    ['a DOCTYPE', '<?xml version="1.0"?><!DOCTYPE t [<!ENTITY x "y">]><tournament/>', 'unsafe'],
    ['a file over the size limit', 'x'.repeat(TDF_MAX_BYTES + 1), 'too_large'],
    ['something that is not a tournament', '<?xml version="1.0"?><html/>', 'not_tdf'],
  ])('throws the parser error for %s', (_label, xml, code) => {
    let caught: unknown;
    try {
      correctTdf(xml, { tournamentId: DISPLAY_ID, organizer: PAT });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(TdfError);
    expect((caught as TdfError).code).toBe(code);
  });

  it.each([
    ['a comment', '<!-- <id/> <organizer popid="1" name="X"/> -->'],
    ['a CDATA section', '<notes><![CDATA[<id/>]]></notes>'],
  ])('edits nothing when data holds %s', (_label, dataExtra) => {
    const input = tomTdf({ idElement: '<id/>', organizerElement: WRONG_ORGANIZER, dataExtra });

    expect(correctTdf(input, { tournamentId: DISPLAY_ID, organizer: PAT })).toEqual({
      xml: input,
      tournamentId: { applied: false, reason: 'unexpected_shape' },
      organizer: { applied: false, reason: 'unexpected_shape' },
    });
  });

  it('never edits inside a comment, even when the only id in data is in one', () => {
    const input = tomTdf({ idElement: '', dataExtra: '<!-- <id/> -->' });

    expect(correctTdf(input, { tournamentId: DISPLAY_ID })).toEqual({
      xml: input,
      tournamentId: { applied: false, reason: 'unexpected_shape' },
    });
  });

  it('drops a fill that would push the file over the size limit, and still applies the organizer', () => {
    // Pad with a comment outside data so the file sits 5 bytes under the limit; filling the id adds 16.
    const base = tomTdf({ idElement: '<id/>', organizerElement: WRONG_ORGANIZER });
    const spare = 5;
    const padding = TDF_MAX_BYTES - spare - new TextEncoder().encode(base).length - '<!---->'.length;
    const input = base.replace('</tournament>', `<!--${'x'.repeat(padding)}--></tournament>`);
    expect(new TextEncoder().encode(input).length).toBe(TDF_MAX_BYTES - spare);

    const result = correctTdf(input, { tournamentId: DISPLAY_ID, organizer: PAT });

    expect(result.tournamentId).toEqual({ applied: false, reason: 'recheck_failed' });
    expect(result.organizer).toMatchObject({ applied: true });
    expect(result.xml).toBe(withOneEdit(input, WRONG_ORGANIZER, PAT_ELEMENT));
  });
});
