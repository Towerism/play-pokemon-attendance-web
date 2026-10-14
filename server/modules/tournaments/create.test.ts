import { describe, expect, it } from 'vitest';
import type { Tournament } from '../pokemon/ports/play-tools-gateway';
import { adoptionCandidates, isShortNotice, selectCreateThrough } from './create';

const GROUP = 'group-1';
const START = new Date('2026-10-20T23:00:00Z');

/** What the planned tournament would be created as. */
const target = { startsAt: START, product: 'tcg', name: 'Friday Cup October', groupId: GROUP };

function listed(id: string, overrides: Partial<Tournament> = {}): Tournament {
  return {
    id,
    name: 'Friday Cup October',
    displayId: `26-10-${id}`,
    groupId: GROUP,
    products: ['tcg'],
    startsAt: START,
    status: 'sanctioned',
    editableUntil: null,
    ...overrides,
  };
}

describe('adoption candidates (ADR-0010 decision 5: adopt instead of create)', () => {
  it('takes a live tournament of the same start, product, league and name', () => {
    expect(adoptionCandidates(target, [listed('a')], new Set()).map((t) => t.id)).toEqual(['a']);
  });

  it('compares names trimmed and case-insensitively', () => {
    expect(adoptionCandidates(target, [listed('a', { name: '  friday CUP october ' })], new Set())).toHaveLength(1);
  });

  it.each([
    ['another start', { startsAt: new Date(START.getTime() + 60_000) }],
    ['no start', { startsAt: null }],
    ['another product', { products: ['vg'] }],
    ['another name', { name: 'Friday Cup November' }],
    ['no name', { name: null }],
    ['another league', { groupId: 'group-2' }],
    ['cancelled', { status: 'cancelled' }],
    ['deleted', { status: 'deleted' }],
    ['invalidated', { status: 'invalidated' }],
  ] as const)('leaves out one with %s', (_why, overrides) => {
    expect(adoptionCandidates(target, [listed('a', overrides as Partial<Tournament>)], new Set())).toEqual([]);
  });

  it('never takes a tournament another planned row already holds', () => {
    expect(adoptionCandidates(target, [listed('a'), listed('b')], new Set(['a'])).map((t) => t.id)).toEqual(['b']);
  });

  it('keeps an approval-pending or errored one: still live', () => {
    const found = adoptionCandidates(target, [listed('a', { status: 'approval-pending' }), listed('b', { status: 'sanctioning-error' })], new Set());
    expect(found.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('orders several by guid, so the same one is always tried first', () => {
    expect(adoptionCandidates(target, [listed('c'), listed('a'), listed('b')], new Set()).map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('short notice (ADR-0010 decision 6: sanction 7 days ahead, as a guideline)', () => {
  const today = '2026-10-13';
  it.each([
    ['2026-10-11', false, 'back-dated: after the fact'],
    ['2026-10-12', false, 'yesterday'],
    ['2026-10-13', true, 'today'],
    ['2026-10-19', true, 'six days ahead'],
    ['2026-10-20', false, 'seven days ahead'],
  ])('%s is %s (%s)', (date, expected) => {
    expect(isShortNotice(date, today)).toBe(expected);
  });

  it('crosses a month end', () => {
    expect(isShortNotice('2026-11-02', '2026-10-28')).toBe(true);
    expect(isShortNotice('2026-11-04', '2026-10-28')).toBe(false);
  });
});

describe('create through a date: which rows it creates', () => {
  const windowStart = '2026-10-11';
  const row = (id: number, localDate: string, state: Parameters<typeof selectCreateThrough>[0][number]['state'], startsAt = `${localDate}T23:00:00Z`) => ({
    id,
    localDate,
    state,
    startsAt,
  });

  it('creates planned and failed rows from the window start through the date, in start order', () => {
    const result = selectCreateThrough(
      [row(3, '2026-11-17', 'planned'), row(1, '2026-10-20', 'failed'), row(2, '2026-10-20', 'planned', '2026-10-20T19:00:00Z')],
      { windowStart, through: '2026-12-31' },
    );
    expect(result.tournaments.map((r) => r.id)).toEqual([2, 1, 3]);
    expect(result).toMatchObject({ count: 3, tooMany: false, suggestedThrough: null, leftOut: [] });
  });

  it('leaves out every other state, with why', () => {
    const result = selectCreateThrough(
      [
        row(1, '2026-10-20', 'skipped'),
        row(2, '2026-10-21', 'created'),
        row(3, '2026-10-22', 'creating'),
        row(4, '2026-10-23', 'unknown'),
        row(5, '2026-10-10', 'planned'),
        row(6, '2026-10-24', 'cancelled'),
      ],
      { windowStart, through: '2026-12-31' },
    );
    expect(result.tournaments).toEqual([]);
    expect(result.leftOut.map((l) => [l.row.id, l.reason])).toEqual([
      [5, 'before_window'],
      [1, 'skipped'],
      [2, 'in_play_tools'],
      [3, 'creating'],
      [4, 'unknown'],
    ]);
  });

  it('selects by the local date, so a slot after the date is not created', () => {
    const result = selectCreateThrough([row(1, '2026-12-31', 'planned'), row(2, '2027-01-01', 'planned')], { windowStart, through: '2026-12-31' });
    expect(result.tournaments.map((r) => r.id)).toEqual([1]);
    expect(result.leftOut).toEqual([]);
  });

  it('says too many above 60, suggesting the latest date that keeps 60 or fewer', () => {
    // 58 rows on separate days, then three on 2027-01-15: the 59th–61st share a date, so it can't be the cut.
    const rows = Array.from({ length: 58 }, (_, i) => row(i + 1, isoPlus('2026-10-20', i), 'planned'));
    rows.push(row(59, '2027-01-15', 'planned'), row(60, '2027-01-15', 'planned'), row(61, '2027-01-15', 'planned'));
    const result = selectCreateThrough(rows, { windowStart, through: '2027-03-31' });
    expect(result).toMatchObject({ count: 61, tooMany: true, suggestedThrough: isoPlus('2026-10-20', 57) });
  });

  it('suggests nothing when even the first date holds more than 60', () => {
    const rows = Array.from({ length: 61 }, (_, i) => row(i + 1, '2026-10-20', 'planned', `2026-10-20T${String(i % 24).padStart(2, '0')}:00:00Z`));
    expect(selectCreateThrough(rows, { windowStart, through: '2026-10-20' })).toMatchObject({ tooMany: true, suggestedThrough: null });
  });
});

function isoPlus(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
