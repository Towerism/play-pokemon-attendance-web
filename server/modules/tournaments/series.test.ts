import { describe, expect, it } from 'vitest';
import type { Series } from '../pokemon/ports/play-tools-gateway';
import { offeredOn, resolveSeries } from './series';

function series(id: string, name: string, from: string, to: string, opts: { product?: string; country?: string } = {}): Series {
  return {
    id,
    name,
    product: opts.product ?? 'tcg',
    categories: ['tcg_std'],
    tags: [],
    playTemplate: null,
    windows: { [opts.country ?? 'US']: { from, to } },
  };
}

const NOV = series('lc-nov', 'League Challenge November 2026', '2026-11-01', '2026-11-30');
const DEC = series('lc-dec', 'League Challenge December 2026', '2026-12-01', '2026-12-31');
const VGC_NOV = series('vg-nov', 'League Challenge November 2026', '2026-11-01', '2026-11-30', { product: 'vg' });
const CUP = series('cup-q4', 'League Cup Q4 2026', '2026-10-01', '2026-12-31');
const CA_NOV = series('ca-nov', 'League Challenge November 2026', '2026-11-01', '2026-11-30', { country: 'CA' });
const LIST = [NOV, DEC, VGC_NOV, CUP, CA_NOV];

const premier = (seriesMatch: string) => ({ kind: 'premier' as const, seriesMatch });
const base = { type: premier('league challenge'), product: 'tcg', country: 'US', pick: null };

describe('resolving a premier template to a series for a date', () => {
  it('finds the one series of the product whose name matches and whose window holds the date', () => {
    expect(resolveSeries({ ...base, date: '2026-11-30' }, LIST)).toEqual({
      kind: 'premier',
      status: 'resolved',
      series: { id: 'lc-nov', name: NOV.name, window: { from: '2026-11-01', to: '2026-11-30' } },
    });
  });

  it('follows the series into the next window on a later date', () => {
    expect(resolveSeries({ ...base, date: '2026-12-01' }, LIST)).toMatchObject({ status: 'resolved', series: { id: 'lc-dec' } });
  });

  it('is series_not_found past every window, offering what play-tools does have that day', () => {
    expect(resolveSeries({ ...base, date: '2027-01-05' }, LIST)).toEqual({ kind: 'premier', status: 'series_not_found', candidates: [] });
    expect(resolveSeries({ ...base, type: premier('Prerelease'), date: '2026-11-10' }, LIST)).toEqual({
      kind: 'premier',
      status: 'series_not_found',
      candidates: [
        { id: 'lc-nov', name: NOV.name },
        { id: 'cup-q4', name: CUP.name },
      ],
    });
  });

  it('only reads the window for the venue country', () => {
    expect(resolveSeries({ ...base, country: 'CA', date: '2026-11-10' }, LIST)).toMatchObject({ series: { id: 'ca-nov' } });
  });

  it('is series_ambiguous when several match the same date, naming them', () => {
    const extra = series('lc-nov-2', 'League Challenge November 2026 (extra)', '2026-11-15', '2026-11-30');
    expect(resolveSeries({ ...base, date: '2026-11-20' }, [...LIST, extra])).toEqual({
      kind: 'premier',
      status: 'series_ambiguous',
      candidates: [
        { id: 'lc-nov', name: NOV.name },
        { id: 'lc-nov-2', name: extra.name },
      ],
    });
  });

  it('takes a picked series over the match, and series_not_found when play-tools no longer has it', () => {
    expect(resolveSeries({ ...base, pick: 'cup-q4', date: '2026-11-20' }, LIST)).toMatchObject({ status: 'resolved', series: { id: 'cup-q4' } });
    expect(resolveSeries({ ...base, pick: 'withdrawn', date: '2026-11-20' }, LIST)).toMatchObject({ status: 'series_not_found' });
  });

  it('a pick of custom, or a custom template, is Custom', () => {
    expect(resolveSeries({ ...base, pick: 'custom', date: '2026-11-20' }, LIST)).toEqual({ kind: 'custom' });
    expect(resolveSeries({ ...base, type: { kind: 'custom' }, date: '2026-11-20' }, LIST)).toEqual({ kind: 'custom' });
  });
});

describe('the series offered on a date', () => {
  it('holds the date in the country window (inclusive at both ends), any product unless one is given', () => {
    expect(offeredOn(LIST, { country: 'US', date: '2026-11-01' }).map((s) => s.id)).toEqual(['lc-nov', 'vg-nov', 'cup-q4']);
    expect(offeredOn(LIST, { country: 'US', date: '2026-12-31', product: 'tcg' }).map((s) => s.id)).toEqual(['lc-dec', 'cup-q4']);
  });

  it('overlaps a range when no single date is given', () => {
    expect(offeredOn(LIST, { country: 'US', range: { from: '2026-12-15', to: '2027-12-15' } }).map((s) => s.id)).toEqual(['lc-dec', 'cup-q4']);
  });
});
