import { describe, expect, it } from 'vitest';
import { tomTdf } from '../../../shared/tdf/__fixtures__/tom';
import { parseTdf } from '../../../shared/tdf/parse';
import type { TournamentParticipant } from '../pokemon/ports/play-tools-gateway';
import { type ResultsCheckInput, normalName, resultsWarnings, uploadability, warningSubjects } from './results-checks';

const NOW = new Date('2026-10-20T12:00:00Z');
const DISPLAY_ID = '26-10-000123';
const ORGANIZER = '7654321';

const read = (o: Partial<Parameters<typeof uploadability>[0]> = {}) => ({
  applicationState: 'sanctioned' as string | null,
  status: 'sanctioned',
  activityState: 'pending' as string | null,
  editableUntil: new Date('2027-01-01T00:00:00Z') as Date | null,
  ...o,
});
const person = (playerId: string, role: string | null, name = `Person ${playerId}`): TournamentParticipant => ({
  recordId: `rec-${playerId}`,
  playerId: playerId as never,
  role,
  isStaff: role !== null,
  name,
});
const organizerOnly = [person(ORGANIZER, 'organizer')];
const PLAYERS = [
  { userid: '1234567', first: 'Ash', last: 'Ketchum' },
  { userid: '2345678', first: 'Misty', last: 'Waterflower' },
];
/** A TOM file whose players are not its organizer, unless a test says so. */
const tdf = (o: Parameters<typeof tomTdf>[0] = {}) => tomTdf({ players: PLAYERS, ...o });

describe('uploadability', () => {
  it.each([
    ['sanctioned, pending, nobody but the organizer', read(), organizerOnly, { ok: true }],
    ['activity null counts as pending', read({ activityState: null }), organizerOnly, { ok: true }],
    ['a failed processing may take a new upload', read({ activityState: 'upload_failed' }), organizerOnly, { ok: true }],
    ['staff do not block', read(), [...organizerOnly, person('111', 'judge')], { ok: true }],
    ['approval-pending', read({ applicationState: 'approval-pending', status: 'approval-pending' }), organizerOnly, { ok: false, code: 'results_not_accepted', reason: 'not_sanctioned' }],
    ['status falls back when application state is missing', read({ applicationState: null, status: 'approval-pending' }), organizerOnly, { ok: false, code: 'results_not_accepted', reason: 'not_sanctioned' }],
    ['cancelled', read({ applicationState: 'cancelled', status: 'cancelled' }), organizerOnly, { ok: false, code: 'results_not_accepted', reason: 'not_sanctioned' }],
    ['status complete', read({ status: 'complete' }), organizerOnly, { ok: false, code: 'results_already_uploaded', reason: null }],
    ['upload in progress', read({ activityState: 'upload_in_progress' }), organizerOnly, { ok: false, code: 'results_already_uploaded', reason: null }],
    ['activity completed', read({ activityState: 'completed' }), organizerOnly, { ok: false, code: 'results_already_uploaded', reason: null }],
    ['a player record', read(), [...organizerOnly, person('222', null)], { ok: false, code: 'results_already_uploaded', reason: null }],
    ['upload_failed with a player record', read({ activityState: 'upload_failed' }), [...organizerOnly, person('222', null)], { ok: false, code: 'results_already_uploaded', reason: null }],
    ['the window closed', read({ editableUntil: NOW }), organizerOnly, { ok: false, code: 'results_not_accepted', reason: 'window_closed' }],
    ['the window closes a second later', read({ editableUntil: new Date(NOW.getTime() + 1000) }), organizerOnly, { ok: true }],
    ['no start, no window', read({ editableUntil: null }), organizerOnly, { ok: true }],
  ])('%s', (_label, r, people, expected) => {
    expect(uploadability(r, people, NOW)).toEqual(expected);
  });
});

describe('resultsWarnings', () => {
  const tournament = { displayId: DISPLAY_ID as string | null, organizerPlayerId: ORGANIZER, products: ['tcg'] as readonly string[] };
  const input = (o: Partial<ResultsCheckInput> & { xml?: string } = {}): ResultsCheckInput => ({
    parsed: parseTdf(o.xml ?? tdf()),
    tournament,
    participants: organizerOnly,
    knownPlayerIds: new Set(['1234567', '2345678']),
    knownNames: new Map(),
    corrections: { organizerReplaced: null, tournamentIdFilled: false },
    ...o,
  });
  const codes = (i: ResultsCheckInput) => resultsWarnings(i).map((w) => w.code);

  it('has none for a file that matches the tournament and whose players are known', () => {
    expect(resultsWarnings(input())).toEqual([]);
  });

  it('reports an organizer the app replaced, with old and new', () => {
    const warnings = resultsWarnings(
      input({ corrections: { organizerReplaced: { fromPlayerId: '1234500', fromName: 'Alex Example', toPlayerId: ORGANIZER, toName: 'Pat Organizer' }, tournamentIdFilled: false } }),
    );
    expect(warnings).toEqual([
      expect.objectContaining({
        code: 'tdf_organizer_replaced',
        from: { playerId: '1234500', name: 'Alex Example' },
        to: { playerId: ORGANIZER, name: 'Pat Organizer' },
        message: expect.stringContaining('1234500 (Alex Example)'),
      }),
    ]);
    expect(warningSubjects(warnings[0]!)).toEqual(['1234500', ORGANIZER]);
  });

  it('warns of a wrong organizer the file still names', () => {
    const w = resultsWarnings(input({ xml: tdf({ organizerElement: '<organizer popid="1234500" name="Alex Example"/>' }) }));
    expect(w).toEqual([expect.objectContaining({ code: 'tdf_wrong_organizer', filePlayerId: '1234500' })]);
    expect(codes(input({ xml: tdf({ organizerElement: '' }) }))).toEqual(['tdf_wrong_organizer']);
    expect(warningSubjects(resultsWarnings(input({ xml: tdf({ organizerElement: '' }) }))[0]!)).toEqual(['none']);
  });

  it('compares the organizer as text: leading zeros differ', () => {
    expect(codes(input({ xml: tdf({ organizerElement: '<organizer popid="07654321" name="Pat Organizer"/>' }) }))).toEqual(['tdf_wrong_organizer']);
  });

  it('keeps a replaced organizer and adds a mismatch when the tournament organizer changed since (D11)', () => {
    const replaced = { fromPlayerId: '1234500', fromName: 'Alex', toPlayerId: ORGANIZER, toName: 'Pat Organizer' };
    const w = codes(input({ tournament: { ...tournament, organizerPlayerId: '5555555' }, corrections: { organizerReplaced: replaced, tournamentIdFilled: false } }));
    expect(w).toEqual(['tdf_organizer_replaced', 'tdf_wrong_organizer']);
  });

  it('reports an id the app filled in, naming the display id', () => {
    const w = resultsWarnings(input({ corrections: { organizerReplaced: null, tournamentIdFilled: true } }));
    expect(w).toEqual([expect.objectContaining({ code: 'tdf_tournament_id_filled', displayId: DISPLAY_ID, message: expect.stringContaining(DISPLAY_ID) })]);
  });

  it('warns of a different id and of a missing one', () => {
    expect(resultsWarnings(input({ xml: tdf({ idElement: '<id>26-10-000999</id>' }) }))).toEqual([
      expect.objectContaining({ code: 'tdf_wrong_tournament', fileTournamentId: '26-10-000999' }),
    ]);
    expect(resultsWarnings(input({ xml: tdf({ idElement: '<id/>' }) }))).toEqual([expect.objectContaining({ code: 'tdf_wrong_tournament', fileTournamentId: null })]);
    expect(codes(input({ xml: tdf({ idElement: '' }) }))).toEqual(['tdf_wrong_tournament']);
  });

  it('warns of a game the tournament does not hold, and not of an unknown spelling', () => {
    expect(resultsWarnings(input({ xml: tdf({ gametype: 'VIDEO_GAME' }) }))).toEqual([expect.objectContaining({ code: 'tdf_wrong_game', fileProduct: 'vg' })]);
    expect(codes(input({ xml: tdf({ gametype: 'POKEMON_GO_SOMETHING' }) }))).toEqual([]);
    expect(codes(input({ xml: tdf({ gametype: null }) }))).toEqual([]);
  });

  it('names each player who is also staff, the organizer not removable', () => {
    const w = resultsWarnings(
      input({
        xml: tdf({ players: [{ userid: '1234567', first: 'Ash', last: 'Ketchum' }, { userid: ORGANIZER, first: 'Pat', last: 'Organizer' }] }),
        participants: [person(ORGANIZER, 'organizer'), person('1234567', 'judge', 'Ash K')],
        knownPlayerIds: new Set(['1234567', ORGANIZER]),
      }),
    );
    expect(w).toEqual([
      expect.objectContaining({ code: 'tdf_staff_also_playing', player: { playerId: '1234567', name: 'Ash Ketchum', role: 'judge', removable: true } }),
      expect.objectContaining({ code: 'tdf_staff_also_playing', player: { playerId: ORGANIZER, name: 'Pat Organizer', role: 'organizer', removable: false } }),
    ]);
    expect(warningSubjects(w[0]!)).toEqual(['1234567', 'judge']);
  });

  it('lists players new to the app, with a hint when a known player has the same name', () => {
    const w = resultsWarnings(
      input({
        xml: tdf({ players: [{ userid: '1234567', first: 'Ash', last: 'Ketchum' }, { userid: '999', first: 'misty ', last: ' WATERFLOWER' }, { userid: '888', first: 'Brock' }] }),
        knownPlayerIds: new Set(['1234567']),
        knownNames: new Map([[normalName('Misty Waterflower'), ['0042', '0100']]]),
      }),
    );
    expect(w).toEqual([
      expect.objectContaining({
        code: 'tdf_unknown_players',
        players: [
          { playerId: '999', name: 'misty WATERFLOWER', knownAs: '0042' },
          { playerId: '888', name: 'Brock', knownAs: null },
        ],
      }),
    ]);
    expect(warningSubjects(w[0]!)).toEqual(['999', '888']);
  });

  it('normalises names ignoring case and spacing', () => {
    expect(normalName('  Misty   WATERflower ')).toBe(normalName('misty waterflower'));
    expect(normalName('')).toBe('');
  });
});
