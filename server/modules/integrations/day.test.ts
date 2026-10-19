import { describe, expect, it } from 'vitest';
import type { PlayerId, SessionDate } from '../../../shared/types/ids';
import { AttendanceDayV1 } from '../../../shared/schemas/integrations';
import type { ActingConnection } from '../pokemon/connection';
import type { Tournament } from '../pokemon/ports/play-tools-gateway';
import type { DaySnapshot } from '../staffing/service';
import { IntegrationError } from './errors';
import { toAttendanceDay } from './day';
import { HELD_BY_OWNER } from '../pokemon/test-helpers';

const DATE = '2026-10-14' as SessionDate;
const OLIVE: ActingConnection = { id: 1, professorPlayerId: '9999991', professorName: 'Olive Organizer', status: 'connected', ...HELD_BY_OWNER };
const BROCK: ActingConnection = { id: 2, professorPlayerId: '0000222', professorName: null, status: 'connected', ...HELD_BY_OWNER };

function tournament(id: string, opts: Partial<Tournament> = {}): Tournament {
  return {
    id,
    name: `Cup ${id}`,
    displayId: `26-10-${id}`,
    groupId: 'group-1',
    products: ['tcg'],
    startsAt: new Date('2026-10-14T23:30:00Z'),
    status: 'sanctioned',
    editableUntil: null,
    ...opts,
  };
}

type Entry = DaySnapshot['tournaments'][number];
const entry = (t: Tournament, organizer = '9999991', staff: Entry['staff'] = []): Entry => ({
  tournament: t,
  organizerPlayerId: organizer as PlayerId,
  staff,
});

function snapshot(tournaments: Entry[], professors: DaySnapshot['professors'] = [{ connectionId: 1, outcome: { status: 'read' } }]): DaySnapshot {
  return { timeZone: 'America/Chicago', tournaments, professors };
}

const project = (s: DaySnapshot, connections: ActingConnection[] = [OLIVE]) => toAttendanceDay({ date: DATE, snapshot: s, connections });

describe('toAttendanceDay', () => {
  it('answers the date, the league timezone, each tournament as the contract has it, and every professor', () => {
    const { day } = project(
      snapshot([
        entry(tournament('t-1', { name: 'Olive Cup', displayId: '26-10-000001', startsAt: new Date('2026-10-14T22:00:00Z') }), '9999991', [
          { playerId: '00456' as PlayerId, name: 'Misty', role: 'judge' },
        ]),
      ]),
    );
    expect(day).toEqual({
      date: '2026-10-14',
      timezone: 'America/Chicago',
      tournaments: [
        {
          id: 't-1',
          name: 'Olive Cup',
          displayId: '26-10-000001',
          startsAt: '2026-10-14T22:00:00.000Z',
          game: 'tcg',
          organizer: { playerId: '9999991', name: 'Olive Organizer' },
          staff: [{ playerId: '00456', name: 'Misty', role: 'judge' }],
        },
      ],
      professors: [{ playerId: '9999991', name: 'Olive Organizer', status: 'read' }],
    });
    expect(AttendanceDayV1.parse(day)).toEqual(day);
  });

  it.each([
    [['tcg'], 'tcg'],
    [['vg'], 'vgc'],
    [['pgo'], 'go'],
    [[], null],
    [['tcg', 'vg'], null],
    [['xyz'], null],
  ] as const)('maps products %j to game %s', (products, game) => {
    const { day } = project(snapshot([entry(tournament('t-1', { products }))]));
    expect(day.tournaments[0]!.game).toBe(game);
  });

  it.each([
    [{ name: 'Olive Cup', displayId: '26-10-1' }, 'Olive Cup'],
    [{ name: null, displayId: '26-10-1' }, '26-10-1'],
    [{ name: '', displayId: '26-10-1' }, '26-10-1'],
    [{ name: null, displayId: null }, 't-1'],
  ])('names a tournament %j as %s', (fields, name) => {
    const { day } = project(snapshot([entry(tournament('t-1', fields))]));
    expect(day.tournaments[0]!.name).toBe(name);
  });

  it("names a professor without a display name 'Professor <player id>', as organizer and in professors", () => {
    const { day } = project(snapshot([entry(tournament('t-1'), '0000222')], [{ connectionId: 2, outcome: { status: 'read' } }]), [BROCK]);
    expect(day.tournaments[0]!.organizer).toEqual({ playerId: '0000222', name: 'Professor 0000222' });
    expect(day.professors).toEqual([{ playerId: '0000222', name: 'Professor 0000222', status: 'read' }]);
  });

  it("names an organizer who isn't a connected professor 'Professor <player id>'", () => {
    const { day } = project(snapshot([entry(tournament('t-1'), '0000444')]));
    expect(day.tournaments[0]!.organizer).toEqual({ playerId: '0000444', name: 'Professor 0000444' });
  });

  it('lists a tournament two reads returned once, in start order, then by id', () => {
    const at = new Date('2026-10-14T22:00:00Z');
    const { day } = project(
      snapshot([entry(tournament('b', { startsAt: at })), entry(tournament('a', { startsAt: at })), entry(tournament('b', { startsAt: at })), entry(tournament('early', { startsAt: new Date('2026-10-14T17:00:00Z') }))]),
    );
    expect(day.tournaments.map((t) => t.id)).toEqual(['early', 'a', 'b']);
  });

  it('keeps staff in contract roles and reports any other stored role as skipped', () => {
    const staff = (['headjudge', 'judge', 'scorekeeper', 'administration', 'translator', 'organizer', 'mystery'] as const).map((role, i) => ({
      playerId: `0010${i}` as PlayerId,
      name: `P${i}`,
      role,
    }));
    const { day, skipped } = project(snapshot([entry(tournament('t-1'), '9999991', staff)]));
    expect(day.tournaments[0]!.staff.map((s) => s.role)).toEqual(['headjudge', 'judge', 'scorekeeper', 'administration', 'translator']);
    expect(skipped).toEqual([
      { tournamentId: 't-1', playerId: '00105', role: 'organizer' },
      { tournamentId: 't-1', playerId: '00106', role: 'mystery' },
    ]);
  });

  it.each([
    ['needs_reconnect', 'needs_reconnect'],
    ['unavailable', 'read_failed'],
    ['rate_limited', 'read_failed'],
    ['forbidden', 'read_failed'],
    ['not_found', 'read_failed'],
    ['unexpected_response', 'read_failed'],
    ['refused', 'read_failed'],
    ['something_new', 'read_failed'],
  ])('reports a professor unread with %s as reason %s', (code, reason) => {
    const { day } = project(snapshot([], [{ connectionId: 1, outcome: { status: 'unread', code } }]));
    expect(day.professors).toEqual([{ playerId: '9999991', name: 'Olive Organizer', status: 'unread', reason }]);
  });

  it('gives a read professor no reason key at all', () => {
    const { day } = project(snapshot([]));
    expect(Object.keys(day.professors[0]!)).not.toContain('reason');
  });

  it('lists professors in connection order with the names they have now', () => {
    const { day } = project(
      snapshot([], [
        { connectionId: 1, outcome: { status: 'read' } },
        { connectionId: 2, outcome: { status: 'unread', code: 'needs_reconnect' } },
      ]),
      [OLIVE, { ...BROCK, professorName: 'Brock Harrison' }],
    );
    expect(day.professors.map((p) => [p.playerId, p.name, p.status])).toEqual([
      ['9999991', 'Olive Organizer', 'read'],
      ['0000222', 'Brock Harrison', 'unread'],
    ]);
  });

  it('refuses the day when a connected professor still has no player id', () => {
    const unidentified: ActingConnection = { id: 3, professorPlayerId: null, professorName: null, status: 'needs_reconnect', ...HELD_BY_OWNER };
    const run = () => project(snapshot([], [{ connectionId: 3, outcome: { status: 'unread', code: 'needs_reconnect' } }]), [unidentified]);
    expect(run).toThrow(IntegrationError);
    expect(run).toThrow(expect.objectContaining({ code: 'professor_unidentified' }));
  });

  it('reports a professor connected after the reads started as unread, never read', () => {
    const { day } = project(snapshot([]), [OLIVE, BROCK]);
    expect(day.professors[1]).toEqual({ playerId: '0000222', name: 'Professor 0000222', status: 'unread', reason: 'read_failed' });
  });
});
