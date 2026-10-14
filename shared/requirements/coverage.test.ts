import { describe, expect, it } from 'vitest';
import { type CoverageInput, type ListedInput, type PeriodCoverage, type PlannedInput, type RequirementInput, type SeriesInput, coverage } from './coverage';

// Builders with fixed ids and dates: every case below says only what it is about.

const TZ = 'America/Chicago';

let nextId = 1;

function requirement(over: Partial<RequirementInput> = {}): RequirementInput {
  return { id: nextId++, seriesMatch: 'League Challenge', product: 'tcg', cadence: 'month', minCount: 1, warnDays: 21, ...over };
}

function series(name: string, from: string, to: string, over: Partial<SeriesInput> = {}): SeriesInput {
  return { id: `s-${name}-${from}`, name, product: 'tcg', windows: { US: { from, to } }, ...over };
}

function listed(over: Partial<ListedInput> = {}): ListedInput {
  return {
    tournamentId: `t-${nextId++}`,
    displayId: null,
    products: ['tcg'],
    startsAt: '2026-11-14T18:00:00Z',
    status: 'sanctioned',
    applicationState: 'sanctioned',
    series: { id: 's-lc', name: 'League Challenge – November' },
    organizer: { playerId: '1000001', name: 'Ash' },
    ...over,
  };
}

function planned(over: Partial<PlannedInput> = {}): PlannedInput {
  return {
    plannedId: nextId++,
    localDate: '2026-11-14',
    product: 'tcg',
    series: { kind: 'resolved', name: 'League Challenge' },
    organizer: { playerId: '1000001', name: 'Ash' },
    ...over,
  };
}

function input(over: Partial<CoverageInput> = {}): CoverageInput {
  return {
    today: '2026-10-14',
    timeZone: TZ,
    country: 'US',
    requirements: [requirement()],
    covers: [],
    upstream: 'read',
    unread: [],
    series: [],
    listed: [],
    planned: [],
    ...over,
  };
}

/** The one requirement's period that starts on `start`. */
function period(result: ReturnType<typeof coverage>, start: string, index = 0): PeriodCoverage {
  const p = result[index]!.periods.find((x) => x.periodStart === start);
  if (!p) throw new Error(`no period ${start}`);
  return p;
}

describe('the latest date and sanction-by date', () => {
  it('ends a month at the end of the matching series window inside it', () => {
    const result = coverage(input({ series: [series('League Challenge', '2026-11-01', '2026-11-20')] }));
    expect(period(result, '2026-11-01')).toMatchObject({
      periodEnd: '2026-11-30',
      latestDate: '2026-11-20',
      sanctionBy: '2026-11-13',
      noSeries: false,
      seriesWindow: { name: 'League Challenge', from: '2026-11-01', to: '2026-11-20' },
    });
  });

  it("keeps the period's end when the window runs past it, and stops a quarter at a window ending inside it", () => {
    const cup = requirement({ seriesMatch: 'League Cup', cadence: 'quarter', warnDays: 45 });
    const result = coverage(input({ requirements: [cup], series: [series('League Cup', '2026-09-01', '2026-11-30')] }));
    expect(period(result, '2026-10-01').latestDate).toBe('2026-11-30');
    expect(period(result, '2026-07-01').latestDate).toBe('2026-09-30');
  });

  it('takes the latest end among several matching windows', () => {
    const result = coverage(
      input({ series: [series('League Challenge A', '2026-11-01', '2026-11-10'), series('League Challenge B', '2026-11-05', '2026-11-25')] }),
    );
    expect(period(result, '2026-11-01').latestDate).toBe('2026-11-25');
  });

  it('matches the series name case-insensitively and only for the requirement product and the US window', () => {
    const result = coverage(
      input({
        series: [
          series('LEAGUE CHALLENGE', '2026-11-01', '2026-11-20'),
          series('League Challenge', '2026-11-01', '2026-11-05', { product: 'vg' }),
          { id: 'ca', name: 'League Challenge', product: 'tcg', windows: { CA: { from: '2026-11-01', to: '2026-11-03' } } },
        ],
      }),
    );
    expect(period(result, '2026-11-01').latestDate).toBe('2026-11-20');
  });

  it('says play-tools offers no series when no matching window overlaps the period', () => {
    const cup = requirement({ seriesMatch: 'League Cup', product: 'pgo', cadence: 'quarter', warnDays: 45 });
    const result = coverage(input({ requirements: [cup], series: [series('League Cup', '2026-10-01', '2026-12-31', { product: 'pgo' })] }));
    expect(period(result, '2027-01-01')).toMatchObject({ latestDate: '2027-03-31', noSeries: true, seriesWindow: null });
    expect(period(result, '2026-10-01')).toMatchObject({ noSeries: false });
    expect(period(result, '2026-07-01')).toMatchObject({ noSeries: true });
  });

  it("can't say there is no series when the series couldn't be read", () => {
    const result = coverage(input({ series: null }));
    expect(period(result, '2026-11-01')).toMatchObject({ latestDate: '2026-11-30', sanctionBy: '2026-11-23', noSeries: false, seriesWindow: null });
  });
});

describe('what counts toward a period', () => {
  it("counts a tournament by its start's date in the league time zone", () => {
    const lateOct31 = listed({ startsAt: '2026-11-01T04:30:00Z' });
    const result = coverage(input({ listed: [lateOct31] }));
    expect(period(result, '2026-10-01').status).toBe('sanctioned');
    expect(period(result, '2026-11-01').status).toBe('missing');
  });

  it('never counts a custom tournament, another product, or a series whose name does not match', () => {
    const result = coverage(
      input({
        listed: [
          listed({ series: null }),
          listed({ products: ['vg'] }),
          listed({ series: { id: 'pr', name: 'Prerelease' } }),
          listed({ series: { id: 'x', name: null } }),
        ],
      }),
    );
    expect(period(result, '2026-11-01')).toMatchObject({ status: 'missing', tournaments: [] });
  });

  it('matches the series name case-insensitively, and lets one tournament count toward two requirements', () => {
    const cup = requirement({ seriesMatch: 'Cup', cadence: 'quarter' });
    const leagueCup = requirement({ seriesMatch: ' league cup ', cadence: 'quarter' });
    const result = coverage(input({ requirements: [cup, leagueCup], listed: [listed({ series: { id: 'c', name: 'LEAGUE CUP Q4' } })] }));
    expect(period(result, '2026-10-01', 0).status).toBe('sanctioned');
    expect(period(result, '2026-10-01', 1).status).toBe('sanctioned');
  });

  it.each([
    ['sanctioned', 'sanctioned', 'sanctioned'],
    ['complete', 'sanctioned', 'sanctioned'],
    ['complete', null, 'sanctioned'],
    ['approval-pending', 'approval-pending', 'pending'],
    ['pending', null, 'pending'],
    ['sanctioning-error', 'sanctioning-error', 'problem'],
    ['cancelled', 'cancelled', 'missing'],
    ['sanctioned', 'deleted', 'missing'],
    ['sanctioned', 'invalidated', 'missing'],
    ['mystery-state', null, 'pending'],
  ])('status %s with application state %s gives %s', (status, applicationState, expected) => {
    const result = coverage(input({ listed: [listed({ status, applicationState })] }));
    expect(period(result, '2026-11-01').status).toBe(expected);
  });

  it('lists what counts, best class first, then by date, with what the grid shows', () => {
    const problem = listed({ tournamentId: 'p', startsAt: '2026-11-02T18:00:00Z', status: 'sanctioning-error', applicationState: 'sanctioning-error' });
    const pending = listed({ tournamentId: 'q', displayId: '26-11-1', startsAt: '2026-11-20T18:00:00Z', status: 'approval-pending', applicationState: 'approval-pending' });
    const early = planned({ plannedId: 7, localDate: '2026-11-03' });
    const result = coverage(input({ listed: [problem, pending], planned: [early] }));
    expect(period(result, '2026-11-01').tournaments).toEqual([
      { tournamentId: 'q', plannedId: null, displayId: '26-11-1', localDate: '2026-11-20', class: 'pending', upstreamStatus: 'approval-pending', organizer: { playerId: '1000001', name: 'Ash' } },
      { tournamentId: null, plannedId: 7, displayId: null, localDate: '2026-11-03', class: 'planned', upstreamStatus: null, organizer: { playerId: '1000001', name: 'Ash' } },
      { tournamentId: 'p', plannedId: null, displayId: null, localDate: '2026-11-02', class: 'problem', upstreamStatus: 'sanctioning-error', organizer: { playerId: '1000001', name: 'Ash' } },
    ]);
  });
});

describe('status and the minimum count', () => {
  const cover = (requirementId: number) => ({ requirementId, periodStart: '2026-11-01', note: 'run by Prof Oak', createdBy: 'organizer', createdAt: '2026-10-10T12:00:00.000Z' });
  const sanctioned = () => listed();
  const problem = () => listed({ status: 'sanctioning-error', applicationState: 'sanctioning-error' });

  it.each([
    ['min 2, one sanctioned and one planned', 'planned', 2, () => [sanctioned()], () => [planned()], false],
    ['min 2, one sanctioned and one problem', 'problem', 2, () => [sanctioned(), problem()], () => [], false],
    ['min 1, one sanctioned and one problem', 'sanctioned', 1, () => [sanctioned(), problem()], () => [], false],
    ['min 2, one sanctioned and a manual cover', 'covered_manual', 2, () => [sanctioned()], () => [], true],
    ['min 2, two sanctioned and a manual cover', 'sanctioned', 2, () => [sanctioned(), sanctioned()], () => [], true],
    ['min 1, only a manual cover', 'covered_manual', 1, () => [], () => [], true],
    ['min 2, one sanctioned and one pending', 'pending', 2, () => [sanctioned(), listed({ status: 'approval-pending', applicationState: 'approval-pending' })], () => [], false],
    ['min 1, nothing', 'missing', 1, () => [], () => [], false],
  ] as const)('%s → %s', (_label, expected, minCount, listedOnes, plannedOnes, covered) => {
    const req = requirement({ minCount });
    const result = coverage(input({ requirements: [req], listed: listedOnes(), planned: plannedOnes(), covers: covered ? [cover(req.id)] : [] }));
    expect(period(result, '2026-11-01').status).toBe(expected);
  });

  it('shows the manual cover on its period only', () => {
    const req = requirement();
    const result = coverage(input({ requirements: [req], covers: [cover(req.id), { ...cover(req.id + 1000), periodStart: '2026-12-01' }] }));
    expect(period(result, '2026-11-01').manualCover).toEqual({ periodStart: '2026-11-01', note: 'run by Prof Oak', createdBy: 'organizer', createdAt: '2026-10-10T12:00:00.000Z' });
    expect(period(result, '2026-12-01').manualCover).toBeNull();
  });
});

describe('planned tournaments', () => {
  it('counts a resolved premier row of the product in the period', () => {
    const result = coverage(input({ planned: [planned({ plannedId: 41, series: { kind: 'resolved', name: 'League Challenge – Nov' } })] }));
    expect(period(result, '2026-11-01')).toMatchObject({ status: 'planned', tournaments: [{ plannedId: 41, class: 'planned' }] });
  });

  it('never counts a custom row, an unresolved premier one or another product', () => {
    const result = coverage(input({ planned: [planned({ series: { kind: 'none' } }), planned({ product: 'vg' })] }));
    expect(period(result, '2026-11-01').status).toBe('missing');
  });

  it("falls back to the template's own series match when its organizer's series couldn't be read", () => {
    const cup = requirement({ seriesMatch: 'League Cup', cadence: 'quarter' });
    const result = coverage(input({ requirements: [cup], planned: [planned({ series: { kind: 'fallback', match: 'league cup' } })] }));
    expect(period(result, '2026-10-01').status).toBe('planned');
  });
});

describe('a failed read is unknown, never missing', () => {
  const ash = { professor: { playerId: '1000001', name: 'Ash' }, code: 'upstream_unavailable' as const, message: 'play-tools is unavailable' };

  it('turns an uncovered period unknown while any listing failed, naming the professor and the best known status', () => {
    const pending = listed({ status: 'approval-pending', applicationState: 'approval-pending' });
    const result = coverage(input({ unread: [ash], listed: [pending] }));
    expect(period(result, '2026-11-01')).toMatchObject({ status: 'unknown', bestKnown: 'pending', unreadProfessors: [ash.professor] });
    expect(period(result, '2026-12-01')).toMatchObject({ status: 'unknown', bestKnown: 'missing' });
  });

  it('keeps a sanctioned or manually covered period whatever failed', () => {
    const req = requirement();
    const result = coverage(
      input({
        requirements: [req],
        unread: [ash],
        listed: [listed({ startsAt: '2026-12-05T18:00:00Z' })],
        covers: [{ requirementId: req.id, periodStart: '2026-11-01', note: 'n', createdBy: 'o', createdAt: '2026-10-01T00:00:00.000Z' }],
      }),
    );
    expect(period(result, '2026-12-01')).toMatchObject({ status: 'sanctioned', bestKnown: null, unreadProfessors: [] });
    expect(period(result, '2026-11-01')).toMatchObject({ status: 'covered_manual', bestKnown: null });
  });

  it.each(['not_connected', 'league_not_selected'] as const)('is unknown everywhere uncovered when upstream was %s', (upstream) => {
    const result = coverage(input({ upstream }));
    for (const p of result[0]!.periods) expect(p).toMatchObject({ status: 'unknown', bestKnown: 'missing' });
  });

  it('names a tournament whose details failed, for its product and period only', () => {
    const t = listed({ tournamentId: 'd', displayId: '26-11-9', series: 'unread' });
    const vgc = requirement({ product: 'vg' });
    const result = coverage(input({ requirements: [requirement(), vgc], listed: [t] }));
    expect(period(result, '2026-11-01', 0)).toMatchObject({ status: 'unknown', bestKnown: 'missing', unreadTournaments: [{ tournamentId: 'd', displayId: '26-11-9' }] });
    expect(period(result, '2026-12-01', 0).status).toBe('missing');
    expect(period(result, '2026-11-01', 1)).toMatchObject({ status: 'missing', unreadTournaments: [] });
  });

  it('ignores a cancelled tournament whose details failed', () => {
    const result = coverage(input({ listed: [listed({ series: 'unread', status: 'cancelled', applicationState: 'cancelled' })] }));
    expect(period(result, '2026-11-01').status).toBe('missing');
  });

  it("turns a period unknown for a planned row it can't judge, never missing", () => {
    const result = coverage(input({ series: null, planned: [planned({ plannedId: 52, series: { kind: 'unjudged' } })] }));
    expect(period(result, '2026-11-01')).toMatchObject({ status: 'unknown', bestKnown: 'missing', unjudgedPlanned: [52] });
  });

  it("can't judge a fallback row whose match doesn't contain the requirement's, so it is unknown too", () => {
    const result = coverage(input({ planned: [planned({ plannedId: 53, series: { kind: 'fallback', match: 'Cup' } })] }));
    expect(period(result, '2026-11-01')).toMatchObject({ status: 'unknown', unjudgedPlanned: [53] });
  });

  it('leaves another product or period alone for an unjudged row', () => {
    const result = coverage(input({ planned: [planned({ product: 'vg', series: { kind: 'unjudged' } })] }));
    expect(period(result, '2026-11-01').status).toBe('missing');
  });
});

describe('urgency counts from the latest date', () => {
  // November, latest date Nov 30, warning lead 21 days.
  it.each([
    ['2026-11-08', 'open'],
    ['2026-11-09', 'at_risk'],
    ['2026-11-23', 'at_risk'],
    ['2026-11-24', 'short_notice'],
    ['2026-11-30', 'short_notice'],
    ['2026-12-01', 'last_chance'],
    ['2026-12-02', 'last_chance'],
    ['2026-12-03', 'missed'],
  ])('on %s an uncovered November is %s', (today, urgency) => {
    expect(period(coverage(input({ today })), '2026-11-01').urgency).toBe(urgency);
  });

  it('has no urgency once sanctioned or covered by hand', () => {
    const req = requirement();
    const result = coverage(
      input({
        today: '2026-12-03',
        requirements: [req],
        listed: [listed()],
        covers: [{ requirementId: req.id, periodStart: '2026-12-01', note: 'n', createdBy: 'o', createdAt: '2026-10-01T00:00:00.000Z' }],
      }),
    );
    expect(period(result, '2026-11-01')).toMatchObject({ status: 'sanctioned', urgency: null });
    expect(period(result, '2026-12-01')).toMatchObject({ status: 'covered_manual', urgency: null });
  });

  it.each(['pending', 'planned', 'problem', 'unknown'])('gives a %s period the same urgency as a missing one', (kind) => {
    const today = '2026-12-01';
    const over: Partial<CoverageInput> =
      kind === 'pending'
        ? { listed: [listed({ status: 'approval-pending', applicationState: 'approval-pending' })] }
        : kind === 'planned'
          ? { planned: [planned()] }
          : kind === 'problem'
            ? { listed: [listed({ status: 'sanctioning-error', applicationState: 'sanctioning-error' })] }
            : { upstream: 'not_connected' };
    expect(period(coverage(input({ today, ...over })), '2026-11-01')).toMatchObject({ status: kind, urgency: 'last_chance' });
  });

  it('is short notice inside 7 days even when the warning lead is shorter', () => {
    const result = coverage(input({ today: '2026-11-25', requirements: [requirement({ warnDays: 3 })] }));
    expect(period(result, '2026-11-01').urgency).toBe('short_notice');
  });

  it('counts from a series window that ends before the period does', () => {
    const result = coverage(input({ today: '2026-11-21', series: [series('League Challenge', '2026-11-01', '2026-11-20')] }));
    expect(period(result, '2026-11-01').urgency).toBe('last_chance');
  });

  it('keeps the 2-day grace across a year end for a quarter', () => {
    const cup = requirement({ seriesMatch: 'League Cup', cadence: 'quarter', warnDays: 45 });
    const at = (today: string) => period(coverage(input({ today, requirements: [cup] })), '2026-10-01').urgency;
    expect([at('2027-01-01'), at('2027-01-02'), at('2027-01-03')]).toEqual(['last_chance', 'last_chance', 'missed']);
    expect([at('2026-11-15'), at('2026-11-16')]).toEqual(['open', 'at_risk']);
  });
});

describe('the action a period offers', () => {
  it.each([
    ['missing', {}, { kind: 'plan' }],
    ['planned', { planned: [planned({ plannedId: 9, localDate: '2026-11-20' }), planned({ plannedId: 8, localDate: '2026-11-05' })] }, { kind: 'create', plannedId: 8 }],
    ['problem', { listed: [listed({ tournamentId: 'err', status: 'sanctioning-error', applicationState: 'sanctioning-error' })] }, { kind: 'open_in_play_tools', tournamentId: 'err' }],
    ['pending', { listed: [listed({ status: 'approval-pending', applicationState: 'approval-pending' })] }, null],
    ['sanctioned', { listed: [listed()] }, null],
  ] as const)('%s offers %o', (status, over, action) => {
    const p = period(coverage(input(over as Partial<CoverageInput>)), '2026-11-01');
    expect(p.status).toBe(status);
    expect(p.action).toEqual(action);
  });

  it('acts on the best known status of an unknown period', () => {
    const unknownPlanned = period(coverage(input({ upstream: 'not_connected', planned: [planned({ plannedId: 3 })] })), '2026-11-01');
    expect(unknownPlanned).toMatchObject({ status: 'unknown', bestKnown: 'planned', action: { kind: 'create', plannedId: 3 } });
    const unknownMissing = period(coverage(input({ upstream: 'not_connected' })), '2026-11-01');
    expect(unknownMissing.action).toEqual({ kind: 'plan' });
    const unknownPending = period(coverage(input({ upstream: 'not_connected', listed: [listed({ status: 'approval-pending', applicationState: null })] })), '2026-11-01');
    expect(unknownPending.action).toBeNull();
  });
});
