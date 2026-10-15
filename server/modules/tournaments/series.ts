import type { Series } from '../pokemon/ports/play-tools-gateway';
import type { LocalDate } from './dates';

/** What a template stores as its tournament type: Custom, or a premier series found per date by its name. */
export type TemplateType = { kind: 'custom' } | { kind: 'premier'; seriesMatch: string };

export interface SeriesRef {
  id: string;
  name: string;
}

/** What a planned tournament's type comes to on its date (ADR-0010 decision 6). */
export type TypeResolution =
  | { kind: 'custom' }
  | { kind: 'premier'; status: 'resolved'; series: SeriesRef & { window: { from: LocalDate; to: LocalDate } | null } }
  /** `unavailable` is the caller's: play-tools' series couldn't be read. */
  | { kind: 'premier'; status: 'series_not_found' | 'series_ambiguous' | 'unavailable'; candidates: SeriesRef[] };

/** A planned tournament's series pick: a series id, `custom`, or none. */
export type SeriesPick = string | null;

export interface SeriesQuery {
  type: TemplateType;
  product: string;
  /** The venue's country: series windows are per country. */
  country: string;
  date: LocalDate;
  pick: SeriesPick;
}

/**
 * The series a planned tournament is created in, from play-tools' live list. A pick wins. Otherwise a premier
 * template takes the one series of its product whose name contains its match and whose window for the
 * country holds the date. The list is never filtered by anything the app keeps.
 */
export function resolveSeries(query: SeriesQuery, list: readonly Series[]): TypeResolution {
  if (query.pick === 'custom' || (query.pick === null && query.type.kind === 'custom')) return { kind: 'custom' };
  if (query.pick !== null) {
    // Only among what play-tools offers for the game, date and country (#162): a stale pick, or one of another
    // game, never creates a tournament under the wrong series or counts toward the wrong requirement.
    const offered = offeredOn(list, query);
    const picked = offered.find((s) => s.id === query.pick);
    if (picked) return resolved(picked, query.country);
    return { kind: 'premier', status: 'series_not_found', candidates: refs(offered) };
  }
  const match = (query.type as Extract<TemplateType, { kind: 'premier' }>).seriesMatch.toLowerCase();
  const offered = offeredOn(list, query);
  const found = offered.filter((s) => s.name.toLowerCase().includes(match));
  if (found.length === 1) return resolved(found[0]!, query.country);
  if (found.length > 1) return { kind: 'premier', status: 'series_ambiguous', candidates: refs(found) };
  return { kind: 'premier', status: 'series_not_found', candidates: refs(offered) };
}

/**
 * The series play-tools offers in `country` on `date` (its window holds it, inclusive), or across `range` (its
 * window overlaps it), of `product` when one is given; in play-tools' order.
 */
export function offeredOn(
  list: readonly Series[],
  query: { country: string; product?: string } & ({ date: LocalDate } | { range: { from: LocalDate; to: LocalDate } }),
): Series[] {
  const [from, to] = 'date' in query ? [query.date, query.date] : [query.range.from, query.range.to];
  return list.filter((s) => {
    const window = s.windows[query.country];
    return window !== undefined && window.from <= to && window.to >= from && (query.product === undefined || s.product === query.product);
  });
}

function resolved(series: Series, country: string): TypeResolution {
  return { kind: 'premier', status: 'resolved', series: { id: series.id, name: series.name, window: series.windows[country] ?? null } };
}

const refs = (list: readonly Series[]): SeriesRef[] => list.map((s) => ({ id: s.id, name: s.name }));
