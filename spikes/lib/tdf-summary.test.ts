import { describe, expect, it } from 'vitest';
import { readTdfHeader, summarizeTdf } from './tdf-summary';

function tdfXml(opts: { gametype?: string; id?: string; organizer?: string } = {}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<tournament type="2" stage="5" version="1.74" gametype="${opts.gametype ?? 'TRADING_CARD_GAME'}" mode="LEAGUECHALLENGE">
  <data>
    <name>Wednesday League Cup</name>
    <id>${opts.id ?? '26-10-000123'}</id>
    <organizer popid="${opts.organizer ?? '7654321'}" name="Pat Organizer" />
    <startdate>10/14/2026</startdate>
  </data>
  <timeelapsed>0</timeelapsed>
  <players>
    <player userid="1234567"><firstname>Ash</firstname><lastname>Ketchum</lastname><birthdate>01/02/2012</birthdate></player>
  </players>
  <pods></pods>
  <finalsoptions></finalsoptions>
</tournament>
`;
}

const PERSONAL = /Ash|Ketchum|01\/02\/2012|1234567|7654321|Pat Organizer|26-10-000123|Wednesday/;

describe('summarizeTdf', () => {
  it.each(['TRADING_CARD_GAME', 'VIDEO_GAME', 'GO'])('keeps the %s gametype, size and element names, and nothing personal', (gametype) => {
    const xml = tdfXml({ gametype });
    const summary = summarizeTdf(xml);

    expect(summary).toEqual({
      tdf: '<redacted>',
      bytes: Buffer.byteLength(xml),
      gametype,
      elements: ['tournament', 'data', 'timeelapsed', 'players', 'pods', 'finalsoptions'],
    });
    expect(JSON.stringify(summary)).not.toMatch(PERSONAL);
  });

  it('reads a base64-encoded file the same way, counting the decoded bytes', () => {
    const xml = tdfXml({ gametype: 'VIDEO_GAME' });
    expect(summarizeTdf(Buffer.from(xml).toString('base64'))).toEqual(summarizeTdf(xml));
  });

  it('refuses input that is neither XML nor base64 XML, without echoing it', () => {
    expect(() => summarizeTdf('Ash Ketchum')).toThrow(/not a TDF/);
    expect(() => summarizeTdf('Ash Ketchum')).not.toThrow(/Ash/);
  });

  it('refuses a file that declares a DOCTYPE or entities', () => {
    expect(() => summarizeTdf(`<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><tournament gametype="GO"/>`)).toThrow(/DOCTYPE/);
  });
});

describe('readTdfHeader', () => {
  it('reads the tournament id, the organizer player id (leading zeros kept) and the gametype', () => {
    expect(readTdfHeader(tdfXml({ id: '26-10-021965', organizer: '0012345', gametype: 'GO' }))).toEqual({
      tournamentId: '26-10-021965',
      organizerId: '0012345',
      gametype: 'GO',
    });
  });
});
