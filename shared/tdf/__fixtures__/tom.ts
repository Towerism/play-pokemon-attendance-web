/**
 * Test builder for tournament files shaped like the ones TOM writes (spikes.md S8 part 2: the `data` field
 * order, `organizer[popid,name]`, `MM/DD/YYYY` dates, optional player elements). Every value is made up.
 */
export interface TomPlayer {
  userid: string;
  first?: string;
  last?: string;
  /** Adds the optional `<dropped>` element some real files have. */
  dropped?: boolean;
  /** Adds the optional `seed`, `order` and `staticseat` elements. */
  seeded?: boolean;
}

export interface TomOptions {
  players?: TomPlayer[];
  name?: string;
  startdate?: string;
  /** Root attributes; `null` leaves the attribute out. */
  gametype?: string | null;
  mode?: string | null;
  /** The raw `id` element, e.g. `'<id/>'`; `''` leaves it out. */
  idElement?: string;
  /** The raw `organizer` element; `''` leaves it out. */
  organizerElement?: string;
  /** Extra raw text placed inside `data`, after `startdate`. */
  dataExtra?: string;
  eol?: '\n' | '\r\n';
  bom?: boolean;
}

export const DEFAULT_PLAYERS: TomPlayer[] = [
  { userid: '1234567', first: 'Ash', last: 'Ketchum' },
  { userid: '7654321', first: 'Misty', last: 'Waterflower' },
];

/** Birthdate written for every player, so tests can check it never leaks and is never changed. */
export const BIRTHDATE = '01/02/2012';

export function tomTdf(opts: TomOptions = {}): string {
  const players = (opts.players ?? DEFAULT_PLAYERS).map((p) =>
    [
      `    <player userid="${p.userid}">`,
      `      <firstname>${p.first ?? ''}</firstname>`,
      `      <lastname>${p.last ?? ''}</lastname>`,
      `      <birthdate>${BIRTHDATE}</birthdate>`,
      `      <creationdate>09/01/2026 18:00:00</creationdate>`,
      `      <lastmodifieddate>09/01/2026 18:00:00</lastmodifieddate>`,
      ...(p.dropped ? ['      <dropped round="2" status="1" timestamp="09/01/2026 19:00:00"/>'] : []),
      ...(p.seeded ? ['      <seed>1</seed>', '      <order>1</order>', '      <staticseat>4</staticseat>'] : []),
      '    </player>',
    ].join('\n'),
  );
  const attr = (name: string, value: string | null | undefined, fallback: string) => {
    const v = value === undefined ? fallback : value;
    return v === null ? '' : ` ${name}="${v}"`;
  };
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<tournament type="2" stage="5" version="1.86"${attr('gametype', opts.gametype, 'TRADING_CARD_GAME')}${attr('mode', opts.mode, 'LEAGUECHALLENGE')}>`,
    '  <data>',
    `    <name>${opts.name ?? 'Wednesday League Challenge'}</name>`,
    ...(opts.idElement === '' ? [] : [`    ${opts.idElement ?? '<id>26-10-000123</id>'}`]),
    '    <city>Springfield</city>',
    '    <state>IL</state>',
    '    <country>US</country>',
    '    <roundtime>50</roundtime>',
    '    <finalsroundtime>75</finalsroundtime>',
    ...(opts.organizerElement === ''
      ? []
      : [`    ${opts.organizerElement ?? '<organizer popid="7654321" name="Pat Organizer"/>'}`]),
    `    <startdate>${opts.startdate ?? '10/14/2026'}</startdate>`,
    ...(opts.dataExtra ? [`    ${opts.dataExtra}`] : []),
    '    <lessswiss>false</lessswiss>',
    '    <autotablenumber>true</autotablenumber>',
    '    <overflowtablestart>0</overflowtablestart>',
    '  </data>',
    '  <timeelapsed>0</timeelapsed>',
    '  <players>',
    ...players,
    '  </players>',
    '  <pods></pods>',
    '  <finalsoptions></finalsoptions>',
    '</tournament>',
    '',
  ];
  return (opts.bom ? '﻿' : '') + lines.join(opts.eol ?? '\n');
}
