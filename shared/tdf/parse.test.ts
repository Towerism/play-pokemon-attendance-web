import { describe, expect, it } from 'vitest';
import { type TomPlayer, tomTdf } from './__fixtures__/tom';
import { TDF_MAX_BYTES, TDF_MAX_PLAYERS, TdfError, type TdfErrorCode, parseTdf } from './parse';

/** The shared TOM-shaped builder, with this file's older call shape. */
const tdf = (players: TomPlayer[], opts: { name?: string; startdate?: string } = {}): string => tomTdf({ players, ...opts });


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
    expect(parseTdf(`\uFEFF${tdf([{ userid: '1', first: 'A' }])}`).players).toHaveLength(1);
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
  it('never returns birthdates or location', () => {
    const out = JSON.stringify(parseTdf(tomTdf()));

    expect(out).not.toMatch(/birth|01\/02\/2012|2012/i);
    expect(out).not.toMatch(/Springfield|IL"|creationdate/);
  });

  it('keeps the organizer out of the tournament, which the attendance preview shows', () => {
    const parsed = parseTdf(tomTdf({ organizerElement: '<organizer popid="7654321" name="Pat Organizer"/>' }));

    expect(JSON.stringify(parsed.tournament)).not.toMatch(/7654321|Pat Organizer/);
    expect(Object.keys(parsed.tournament).sort()).toEqual(['date', 'name']);
    expect(parsed.header.organizer).toEqual({ playerId: '7654321', name: 'Pat Organizer' });
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

describe("parseTdf: the file's tournament id", () => {
  it('reads the id TOM wrote', () => {
    expect(parseTdf(tomTdf({ idElement: '<id>26-10-000123</id>' })).header.tournamentId).toBe('26-10-000123');
  });

  it.each([
    ['self-closing', '<id/>'],
    ['open and close', '<id></id>'],
    ['only whitespace', '<id>  \n </id>'],
    ['missing', ''],
    ['a nested element', '<id><x/></id>'],
  ])('is null when the id is %s', (_label, idElement) => {
    expect(parseTdf(tomTdf({ idElement })).header.tournamentId).toBeNull();
  });

  it('reads an id that is present but malformed as written', () => {
    expect(parseTdf(tomTdf({ idElement: '<id> not-an-id </id>' })).header.tournamentId).toBe('not-an-id');
  });
});

describe("parseTdf: the file's organizer", () => {
  it('reads the popid as text, keeping leading zeros, and decodes the name', () => {
    const organizerElement = '<organizer popid=" 0012345 " name="Pat &amp; Sam  Organizer"/>';

    expect(parseTdf(tomTdf({ organizerElement })).header.organizer).toEqual({ playerId: '0012345', name: 'Pat & Sam Organizer' });
  });

  it('keeps a popid that is not a valid player ID as written', () => {
    expect(parseTdf(tomTdf({ organizerElement: '<organizer popid="P-42" name="Pat"/>' })).header.organizer?.playerId).toBe('P-42');
  });

  it('reads an organizer with no name as an empty name', () => {
    expect(parseTdf(tomTdf({ organizerElement: '<organizer popid="7654321"/>' })).header.organizer).toEqual({
      playerId: '7654321',
      name: '',
    });
  });

  it.each([
    ['missing', ''],
    ['listed twice', '<organizer popid="1" name="A"/><organizer popid="2" name="B"/>'],
    ['without a popid', '<organizer name="Pat"/>'],
    ['with a blank popid', '<organizer popid="  " name="Pat"/>'],
  ])('is null when the organizer is %s', (_label, organizerElement) => {
    expect(parseTdf(tomTdf({ organizerElement })).header.organizer).toBeNull();
  });
});

describe("parseTdf: the file's game", () => {
  it.each([
    ['TRADING_CARD_GAME', 'LEAGUECHALLENGE', 'tcg'],
    ['VIDEO_GAME', 'VGCPREMIER', 'vg'],
    ['GO', 'GOPREMIER', 'pgo'],
  ])('maps gametype %s to the play-tools product', (gametype, mode, product) => {
    expect(parseTdf(tomTdf({ gametype, mode })).header.game).toEqual({ gametype, mode, product });
  });

  it.each([['TCG'], ['go'], ['POKEMON_GO'], ['']])('gives no product for gametype %j rather than guessing', (gametype) => {
    expect(parseTdf(tomTdf({ gametype })).header.game.product).toBeNull();
  });

  it('reads a missing gametype and mode as null', () => {
    expect(parseTdf(tomTdf({ gametype: null, mode: null })).header.game).toEqual({ gametype: null, mode: null, product: null });
  });
});

describe('parseTdf: optional player elements in real files', () => {
  it('reads players and header the same with dropped, seed, order and staticseat present', () => {
    const plain = parseTdf(tomTdf());
    const withExtras = parseTdf(
      tomTdf({
        players: [
          { userid: '1234567', first: 'Ash', last: 'Ketchum', dropped: true },
          { userid: '7654321', first: 'Misty', last: 'Waterflower', seeded: true },
        ],
      }),
    );

    expect(withExtras).toEqual(plain);
  });
});
