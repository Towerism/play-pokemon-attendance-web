import { describe, expect, it } from 'vitest';
import { TDF_MAX_BYTES, TDF_MAX_PLAYERS, TdfError, type TdfErrorCode, parseTdf } from './parse';

interface FakePlayer {
  userid: string;
  first?: string;
  last?: string;
}

/** A tournament file shaped like the ones TOM writes (`tournament > data`, `players > player[@userid]`). */
function tdf(players: FakePlayer[], opts: { name?: string; startdate?: string } = {}): string {
  const rows = players
    .map(
      (p) => `    <player userid="${p.userid}">
      <firstname>${p.first ?? ''}</firstname>
      <lastname>${p.last ?? ''}</lastname>
      <birthdate>01/02/2012</birthdate>
      <creationdate>09/01/2026 18:00:00</creationdate>
      <lastmodifieddate>09/01/2026 18:00:00</lastmodifieddate>
    </player>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<tournament type="2" stage="5" version="1.74" gametype="TRADING_CARD_GAME" mode="LEAGUECHALLENGE">
  <data>
    <name>${opts.name ?? 'Wednesday League Cup'}</name>
    <id>26-10-000123</id>
    <city>Springfield</city>
    <state>IL</state>
    <country>US</country>
    <roundtime>50</roundtime>
    <finalsroundtime>75</finalsroundtime>
    <organizer popid="7654321" name="Pat Organizer" />
    <startdate>${opts.startdate ?? '10/14/2026'}</startdate>
    <lessswiss>false</lessswiss>
  </data>
  <timeelapsed>0</timeelapsed>
  <players>
${rows}
  </players>
  <pods></pods>
  <finalsoptions></finalsoptions>
</tournament>
`;
}

describe('parseTdf', () => {
  it('reads every player as "first last" with the ID as a string', () => {
    const result = parseTdf(
      tdf([
        { userid: '1234567', first: 'Ash', last: 'Ketchum' },
        { userid: '7654321', first: 'Misty', last: 'Waterflower' },
      ]),
    );

    expect(result.players).toEqual([
      { playerId: '1234567', name: 'Ash Ketchum' },
      { playerId: '7654321', name: 'Misty Waterflower' },
    ]);
  });
});

describe('parseTdf: IDs and names', () => {
  it('keeps leading zeros, even though the ID looks numeric', () => {
    expect(parseTdf(tdf([{ userid: '0012345', first: 'Ash', last: 'K' }])).players[0]?.playerId).toBe('0012345');
  });

  it('reads a file with a single player', () => {
    expect(parseTdf(tdf([{ userid: '1', first: 'Solo', last: 'Player' }])).players).toEqual([
      { playerId: '1', name: 'Solo Player' },
    ]);
  });

  it.each([
    ['only a first name', { first: 'Ash' }, 'Ash'],
    ['only a last name', { last: 'Ketchum' }, 'Ketchum'],
    ['no name at all', {}, ''],
    ['padded and doubled spaces', { first: '  Mary  Jane ', last: ' Watson ' }, 'Mary Jane Watson'],
  ])('tidies %s', (_label, parts, expected) => {
    expect(parseTdf(tdf([{ userid: '1', ...parts }])).players[0]?.name).toBe(expected);
  });

  it('cuts names to 100 characters, the limit for a player name', () => {
    expect(parseTdf(tdf([{ userid: '1', first: 'x'.repeat(150) }])).players[0]?.name).toHaveLength(100);
  });

  it('decodes the standard XML escapes in names', () => {
    expect(parseTdf(tdf([{ userid: '1', first: 'Zoë &amp; Co', last: '&lt;3' }])).players[0]?.name).toBe('Zoë & Co <3');
  });

  it('ignores a name element that is not plain text rather than printing "[object Object]"', () => {
    const xml = tdf([{ userid: '1', first: 'Ash', last: 'K' }]).replace('<lastname>K</lastname>', '<lastname><b>K</b></lastname>');
    expect(parseTdf(xml).players[0]?.name).toBe('Ash');
  });

  it('decodes an escape once: "&amp;lt;" is the text "&lt;"', () => {
    expect(parseTdf(tdf([{ userid: '1', first: '&amp;lt;3' }])).players[0]?.name).toBe('&lt;3');
  });

  it('decodes numeric character references', () => {
    expect(parseTdf(tdf([{ userid: '1', first: 'Zo&#235;', last: 'J&#x00F6;rg' }])).players[0]?.name).toBe('Zoë Jörg');
  });

  it('accepts a byte-order mark before the XML declaration', () => {
    expect(parseTdf(`﻿${tdf([{ userid: '1', first: 'A' }])}`).players).toHaveLength(1);
  });
});

describe('parseTdf: duplicates and invalid rows', () => {
  it('lists a player once when the file repeats them, keeping the first name it has', () => {
    const result = parseTdf(
      tdf([
        { userid: '1' },
        { userid: '2', first: 'Brock' },
        { userid: '1', first: 'Ash' },
        { userid: '1', first: 'Ashley' },
      ]),
    );

    expect(result.players).toEqual([
      { playerId: '1', name: 'Ash' },
      { playerId: '2', name: 'Brock' },
    ]);
    expect(result.duplicates).toBe(2);
  });

  it('treats IDs that differ only by surrounding spaces as the same player', () => {
    const result = parseTdf(tdf([{ userid: '42' }, { userid: ' 42 ' }]));
    expect(result.players).toEqual([{ playerId: '42', name: '' }]);
    expect(result.duplicates).toBe(1);
  });

  it('does not treat IDs that differ by leading zeros as the same player', () => {
    expect(parseTdf(tdf([{ userid: '42' }, { userid: '042' }])).players.map((p) => p.playerId)).toEqual(['42', '042']);
  });

  it.each([
    ['empty', ''],
    ['not digits', 'abc123'],
    ['negative', '-5'],
    ['a decimal', '12.5'],
    ['too long (13 digits)', '1234567890123'],
  ])('reports a player whose ID is %s instead of importing them', (_label, userid) => {
    const result = parseTdf(tdf([{ userid: '1', first: 'Good' }, { userid, first: 'Bad', last: 'Row' }]));

    expect(result.players).toEqual([{ playerId: '1', name: 'Good' }]);
    expect(result.invalid).toEqual([{ name: 'Bad Row', reason: 'Player ID must be 1–12 digits' }]);
  });

  it('reports a player with no userid attribute', () => {
    const xml = tdf([{ userid: '1' }, { userid: '2' }]).replace('<player userid="1">', '<player>');
    expect(parseTdf(xml).invalid).toEqual([{ name: '', reason: 'Player ID must be 1–12 digits' }]);
  });

  it('accepts the 12-digit maximum', () => {
    expect(parseTdf(tdf([{ userid: '123456789012' }])).players).toHaveLength(1);
  });
});

describe('parseTdf: what it keeps', () => {
  it('returns names and IDs only: no birthdates, organizer or location', () => {
    const out = JSON.stringify(parseTdf(tdf([{ userid: '1', first: 'Ash' }])));

    expect(out).not.toMatch(/birth|01\/02\/2012|2012/i);
    expect(out).not.toMatch(/7654321|Pat Organizer|popid/);
    expect(out).not.toMatch(/Springfield|creationdate/);
  });
});

describe('parseTdf: rejected files', () => {
  const rejects = (xml: string, code: TdfErrorCode) => {
    let caught: unknown;
    try {
      parseTdf(xml);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TdfError);
    expect((caught as TdfError).code).toBe(code);
    expect((caught as TdfError).message).not.toBe('');
  };

  it('refuses an internal entity (billion laughs) without expanding it', () => {
    const lol = `<?xml version="1.0"?>
<!DOCTYPE tournament [
  <!ENTITY lol "lol">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
  <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
]>
<tournament><players><player userid="1"><firstname>&lol3;</firstname></player></players></tournament>`;
    rejects(lol, 'unsafe');
  });

  it('refuses an external entity (XXE)', () => {
    const xxe = `<?xml version="1.0"?>
<!DOCTYPE tournament [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
<tournament><players><player userid="1"><firstname>&xxe;</firstname></player></players></tournament>`;
    rejects(xxe, 'unsafe');
  });

  it('refuses any DOCTYPE, whatever its case or spacing', () => {
    rejects(tdf([{ userid: '1' }]).replace('<tournament ', '<!doctype   tournament>\n<tournament '), 'unsafe');
  });

  it('does not expand an undeclared entity reference', () => {
    const name = parseTdf(tdf([{ userid: '1', first: '&xxe;' }])).players[0]?.name;
    expect(name).toBe('&xxe;');
  });

  it(`refuses a file over ${TDF_MAX_BYTES} bytes before parsing it`, () => {
    const padding = `<!--${'x'.repeat(TDF_MAX_BYTES)}-->`;
    rejects(tdf([{ userid: '1' }]) + padding, 'too_large');
  });

  it('counts the size in bytes, not characters', () => {
    const base = tdf([{ userid: '1' }]);
    // Multi-byte characters: under the cap in characters, over it in UTF-8 bytes.
    const wide = 'é'.repeat(Math.ceil((TDF_MAX_BYTES - base.length) / 2) + 10);
    expect(base.length + wide.length).toBeLessThan(TDF_MAX_BYTES);
    rejects(base.replace('Springfield', wide), 'too_large');
  });

  it(`accepts ${TDF_MAX_PLAYERS} players and refuses one more`, () => {
    const many = (n: number) => tdf(Array.from({ length: n }, (_, i) => ({ userid: String(i + 1) })));

    expect(parseTdf(many(TDF_MAX_PLAYERS)).players).toHaveLength(TDF_MAX_PLAYERS);
    rejects(many(TDF_MAX_PLAYERS + 1), 'too_many_players');
  });

  it.each([
    ['plain text', 'hello, not a tournament'],
    ['an empty file', ''],
    ['broken XML', '<tournament><players><player userid="1"></players>'],
    ['JSON', '[{"name":"Ash","player_id":"1"}]'],
  ])('refuses %s as not a TDF', (_label, content) => {
    rejects(content, 'not_tdf');
  });

  it('refuses XML that is not a tournament', () => {
    rejects('<?xml version="1.0"?><html><body>hi</body></html>', 'not_tdf');
  });

  it('refuses a tournament with no players', () => {
    rejects(tdf([]), 'no_players');
  });

  it('refuses a tournament whose players are all invalid, reporting nothing to import', () => {
    rejects(tdf([{ userid: 'x' }, { userid: '' }]), 'no_players');
  });
});

describe('parseTdf: tournament', () => {
  it('reads the tournament name and start date as YYYY-MM-DD', () => {
    expect(parseTdf(tdf([{ userid: '1' }], { name: 'Wed League Cup', startdate: '10/14/2026' })).tournament).toEqual({
      name: 'Wed League Cup',
      date: '2026-10-14',
    });
  });

  it.each([['14/10/2026'], ['2026-10-14'], ['02/30/2026'], ['']])('leaves an unreadable start date (%j) as null', (startdate) => {
    expect(parseTdf(tdf([{ userid: '1' }], { startdate })).tournament.date).toBeNull();
  });

  it('leaves a blank tournament name as null', () => {
    expect(parseTdf(tdf([{ userid: '1' }], { name: '  ' })).tournament.name).toBeNull();
  });
});
