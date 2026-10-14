import { and, asc, count, eq, inArray } from 'drizzle-orm';
import type { Cadence } from '../../../shared/requirements/periods';
import { periodOf } from '../../../shared/requirements/periods';
import type { ManualCoverInput, Product } from '../../../shared/requirements/coverage';
import type { Db } from '../../db/client';
import { requirementManualCover, tournamentRequirement } from '../../db/schema';
import { TournamentsError } from './errors';

/** What a league must hold each period (ADR-0010 decision 12). */
export interface Requirement {
  id: number;
  seriesMatch: string;
  product: Product;
  cadence: Cadence;
  minCount: number;
  warnDays: number;
  active: boolean;
}

export interface RequirementBody {
  seriesMatch: string;
  product: Product;
  cadence: Cadence;
  minCount?: number;
  warnDays?: number;
  active?: boolean;
}

export type RequirementPatch = Partial<RequirementBody>;

export interface ManualCover {
  periodStart: string;
  note: string;
  createdBy: string;
  /** ISO. */
  createdAt: string;
}

export interface TournamentRequirements {
  /** Every requirement, by id; seeded on first use. */
  list(leagueId: string): Requirement[];
  /** The ones switched on, by id. */
  active(leagueId: string): Requirement[];
  /** @throws TournamentsError `requirement_exists`, `too_many_requirements` */
  create(leagueId: string, body: RequirementBody): Requirement;
  /** @throws TournamentsError `not_found`, `requirement_exists`, `requirement_has_covers` */
  update(leagueId: string, id: number, patch: RequirementPatch): Requirement;
  /** Records or replaces the period's cover. @throws TournamentsError `not_found`, `invalid_period` */
  putCover(leagueId: string, id: number, periodStart: string, body: { note: string }, by: string): ManualCover;
  /** @throws TournamentsError `not_found` (the requirement, or no cover for the period) */
  deleteCover(leagueId: string, id: number, periodStart: string): void;
  /** Every cover of the league's requirements, on or off. */
  covers(leagueId: string): ManualCoverInput[];
}

/** The organizer's six (2026-10-12): a League Cup each quarter and a League Challenge each month, per game. */
const SEEDS: readonly Omit<RequirementBody, 'minCount' | 'warnDays' | 'active'>[] = [
  ...(['tcg', 'vg', 'pgo'] as const).map((product) => ({ seriesMatch: 'League Cup', product, cadence: 'quarter' as const })),
  ...(['tcg', 'vg', 'pgo'] as const).map((product) => ({ seriesMatch: 'League Challenge', product, cadence: 'month' as const })),
];

/** How far ahead an uncovered period turns at risk, by default (decision 12). */
const DEFAULT_WARN_DAYS: Record<Cadence, number> = { month: 21, quarter: 45 };

/** Enough for any league; keeps the coverage read bounded. */
export const MAX_REQUIREMENTS = 50;

type Row = typeof tournamentRequirement.$inferSelect;

const view = (r: Row): Requirement => ({
  id: r.id,
  seriesMatch: r.seriesMatch,
  product: r.product,
  cadence: r.cadence,
  minCount: r.minCount,
  warnDays: r.warnDays,
  active: r.active,
});

const key = (r: Pick<Requirement, 'seriesMatch' | 'product' | 'cadence'>) => `${r.product}|${r.cadence}|${r.seriesMatch.trim().toLowerCase()}`;

export function createRequirements(deps: { db: Db; now: () => Date }): TournamentRequirements {
  const { db } = deps;

  /** Every row, seeding the six first when the league has none. Rows are never deleted, so none means never seeded. */
  function rows(leagueId: string): Row[] {
    return db.transaction((tx) => {
      const { n } = tx.select({ n: count() }).from(tournamentRequirement).where(eq(tournamentRequirement.leagueId, leagueId)).get()!;
      if (n === 0) {
        const createdAt = deps.now();
        tx.insert(tournamentRequirement)
          .values(SEEDS.map((s) => ({ ...s, leagueId, minCount: 1, warnDays: DEFAULT_WARN_DAYS[s.cadence], active: true, createdAt })))
          .run();
      }
      return tx.select().from(tournamentRequirement).where(eq(tournamentRequirement.leagueId, leagueId)).orderBy(asc(tournamentRequirement.id)).all();
    });
  }

  function row(leagueId: string, id: number): Row {
    const found = rows(leagueId).find((r) => r.id === id);
    if (!found) throw new TournamentsError('not_found', 'No such requirement.');
    return found;
  }

  function refuseDuplicate(all: readonly Row[], candidate: Requirement | (RequirementBody & { id?: number })) {
    const clash = all.find((r) => r.id !== candidate.id && key(r) === key(candidate));
    if (clash) {
      throw new TournamentsError('requirement_exists', `“${clash.seriesMatch}” is already required for this game and cadence.`, { requirementId: clash.id });
    }
  }

  return {
    list: (leagueId) => rows(leagueId).map(view),

    active: (leagueId) => rows(leagueId).filter((r) => r.active).map(view),

    create(leagueId, body) {
      const all = rows(leagueId);
      if (all.length >= MAX_REQUIREMENTS) {
        throw new TournamentsError('too_many_requirements', `A league can have at most ${MAX_REQUIREMENTS} requirements. Turn one off and edit it instead.`);
      }
      const seriesMatch = body.seriesMatch.trim();
      refuseDuplicate(all, { ...body, seriesMatch });
      const created = db
        .insert(tournamentRequirement)
        .values({
          leagueId,
          seriesMatch,
          product: body.product,
          cadence: body.cadence,
          minCount: body.minCount ?? 1,
          warnDays: body.warnDays ?? DEFAULT_WARN_DAYS[body.cadence],
          active: body.active ?? true,
          createdAt: deps.now(),
        })
        .returning()
        .get();
      return view(created);
    },

    update(leagueId, id, patch) {
      const current = row(leagueId, id);
      const next = { ...view(current), ...patch, ...(patch.seriesMatch !== undefined && { seriesMatch: patch.seriesMatch.trim() }) };
      refuseDuplicate(rows(leagueId), next);
      if (next.cadence !== current.cadence) {
        const covered = db.select({ id: requirementManualCover.id }).from(requirementManualCover).where(eq(requirementManualCover.requirementId, id)).get();
        if (covered) {
          throw new TournamentsError('requirement_has_covers', 'Remove its manual covers before changing the cadence: they are for the old periods.');
        }
      }
      const { id: _id, ...fields } = next;
      return view(db.update(tournamentRequirement).set(fields).where(eq(tournamentRequirement.id, id)).returning().get());
    },

    putCover(leagueId, id, periodStart, body, by) {
      const requirement = row(leagueId, id);
      if (!periodOf(requirement.cadence, periodStart)) {
        const which = requirement.cadence === 'month' ? 'a month' : 'a quarter (Jan, Apr, Jul or Oct)';
        throw new TournamentsError('invalid_period', `${periodStart} isn't the first day of ${which}.`);
      }
      // Timestamps are stored to the second: answer with what a later read returns.
      const values = { note: body.note.trim(), createdBy: by, createdAt: new Date(Math.floor(deps.now().getTime() / 1000) * 1000) };
      db.insert(requirementManualCover)
        .values({ requirementId: id, periodStart, ...values })
        .onConflictDoUpdate({ target: [requirementManualCover.requirementId, requirementManualCover.periodStart], set: values })
        .run();
      return { periodStart, note: values.note, createdBy: by, createdAt: values.createdAt.toISOString() };
    },

    deleteCover(leagueId, id, periodStart) {
      row(leagueId, id);
      const removed = db
        .delete(requirementManualCover)
        .where(and(eq(requirementManualCover.requirementId, id), eq(requirementManualCover.periodStart, periodStart)))
        .returning({ id: requirementManualCover.id })
        .all();
      if (removed.length === 0) throw new TournamentsError('not_found', 'No manual cover for that period.');
    },

    covers(leagueId) {
      const ids = rows(leagueId).map((r) => r.id);
      return db
        .select()
        .from(requirementManualCover)
        .where(inArray(requirementManualCover.requirementId, ids))
        .orderBy(asc(requirementManualCover.requirementId), asc(requirementManualCover.periodStart))
        .all()
        .map((c) => ({ requirementId: c.requirementId, periodStart: c.periodStart, note: c.note, createdBy: c.createdBy, createdAt: c.createdAt.toISOString() }));
    },
  };
}
