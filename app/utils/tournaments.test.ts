import { describe, expect, it } from 'vitest';
import type { PeriodCoverage } from '../../shared/requirements/coverage';
import type { Requirement } from '../../server/modules/tournaments/requirements';
import type { RequiredEventsCoverage } from '../../server/modules/tournaments/required-events';
import type { SupportDetails } from '../../server/modules/submission/service';
import type { EditValues } from '../../server/modules/tournaments/edit';
import type { CreateThroughPreview, Template, TournamentOptions, UpcomingEntry } from '../../server/modules/tournaments/service';
import {
  type TemplateFormState,
  admissionInput,
  admissionInputText,
  registrationProblem,
  startLine,
  FIELD_LABEL,
  blankToNull,
  valueText,
  badgeCount,
  bannerLines,
  cancelConfirmed,
  cellView,
  changedValues,
  createThroughView,
  defaultTicks,
  excludedKeys,
  requirementPatch,
  templateFormProblem,
  templateTypeChoices,
  venueChoices,
  venueValue,
  downloadName,
  leftOutText,
  outcomeLabel,
  supportText,
  entryStatus,
  groupByDate,
  isShortNotice,
  planOneDefaults,
  requirementLabel,
  retryContext,
  rowActions,
  sanctionTag,
  tabFromQuery,
  tabQuery,
  tournamentsTabs,
  upcomingNotice,
  upcomingQuery,
  AS_TEMPLATE,
  detailsFromTemplate,
  newTournamentChanges,
  newTournamentFormats,
  newTournamentTypeChoices,
  plannedErrorText,
  typeStillOffered,
} from './tournaments';
import { dayLabel, periodLabel, todayIn } from './dates';

// The Tournaments page's decisions (#98): what each cell, entry and dialog shows and what it may send. Every
// "today" is passed in; nothing here reads the clock.

function requirement(overrides: Partial<Requirement> = {}): Requirement {
  return { id: 1, seriesMatch: 'League Challenge', product: 'tcg', cadence: 'month', minCount: 1, warnDays: 21, active: true, ...overrides };
}

function period(overrides: Partial<PeriodCoverage> = {}): PeriodCoverage {
  return {
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    latestDate: '2026-10-31',
    sanctionBy: '2026-10-24',
    seriesWindow: null,
    noSeries: false,
    status: 'missing',
    bestKnown: null,
    urgency: 'at_risk',
    tournaments: [],
    manualCover: null,
    unreadProfessors: [],
    unreadTournaments: [],
    unjudgedPlanned: [],
    action: { kind: 'plan' },
    ...overrides,
  };
}

function template(overrides: Partial<Template> = {}): Template {
  return {
    id: 1,
    name: 'Cup',
    organizerPlayerId: '9999991',
    product: 'tcg',
    category: 'tcg_std',
    type: { kind: 'custom' },
    venue: { id: 'v1', label: 'Card Shop', timeZone: 'America/Chicago', country: 'US' },
    startTime: '18:00',
    registration: { kind: 'on_site', opensBeforeMin: 60, closesAfterMin: 15, admissionCents: null },
    contactEmail: 'league@example.com',
    contactPhone: null,
    details: null,
    eventWebsite: null,
    archived: false,
    legacyAdmission: null,
    ...overrides,
  };
}

describe('todayIn', () => {
  it('is the date in the league’s time zone, not UTC’s or the browser’s', () => {
    expect(todayIn('America/Chicago', new Date('2026-10-15T03:00:00Z'))).toBe('2026-10-14');
    expect(todayIn('America/Chicago', new Date('2026-10-15T05:00:00Z'))).toBe('2026-10-15');
  });
});

describe('isShortNotice', () => {
  it.each([
    ['2026-10-13', false], // held yesterday: back-dated, not short notice
    ['2026-10-14', true],
    ['2026-10-20', true],
    ['2026-10-21', false],
  ])('%s with today 2026-10-14 → %s', (date, expected) => {
    expect(isShortNotice(date, '2026-10-14')).toBe(expected);
  });
});

describe('badgeCount', () => {
  it('counts every cell at risk or worse, across requirements', () => {
    const coverage = {
      requirements: [
        { requirement: requirement(), periods: [period({ urgency: 'open' }), period({ urgency: 'at_risk' }), period({ urgency: null })] },
        { requirement: requirement({ id: 2 }), periods: [period({ urgency: 'short_notice' }), period({ urgency: 'last_chance' }), period({ urgency: 'missed' })] },
      ],
    };
    expect(badgeCount(coverage)).toBe(4);
  });

  it('is 0 before coverage loads', () => {
    expect(badgeCount(null)).toBe(0);
    expect(badgeCount(undefined)).toBe(0);
  });
});

describe('labels', () => {
  it('names a month or a calendar quarter', () => {
    expect(periodLabel({ periodStart: '2026-10-01' }, 'month')).toBe('Oct 2026');
    expect(periodLabel({ periodStart: '2026-10-01' }, 'quarter')).toBe('Q4 2026');
    expect(periodLabel({ periodStart: '2027-01-01' }, 'quarter')).toBe('Q1 2027');
  });

  it('names a requirement by its match, game and cadence', () => {
    expect(requirementLabel(requirement({ seriesMatch: 'League Cup', product: 'tcg', cadence: 'quarter' }))).toBe('League Cup · TCG · each quarter');
    expect(requirementLabel(requirement({ product: 'pgo' }))).toBe('League Challenge · GO · each month');
    expect(requirementLabel(requirement({ product: 'vg' }))).toBe('League Challenge · VGC · each month');
  });
});

describe('cellView', () => {
  const ctx = { today: '2026-10-14', unread: [] };
  const cup = requirement({ seriesMatch: 'League Cup', cadence: 'quarter' });
  const q4 = (o: Partial<PeriodCoverage> = {}) => period({ periodStart: '2026-10-01', periodEnd: '2026-12-31', latestDate: '2026-12-31', sanctionBy: '2026-12-24', ...o });

  it.each([
    ['sanctioned', 'Sanctioned', 'success'],
    ['covered_manual', 'Covered (manual)', 'success'],
    ['pending', 'Approval pending', 'info'],
    ['planned', 'Planned, not in play-tools', 'warning'],
    ['problem', 'Sanctioning error', 'error'],
    ['missing', 'Missing', 'error'],
    ['unknown', 'Can’t confirm', 'warning'],
  ] as const)('labels %s', (status, label, color) => {
    expect(cellView(cup, q4({ status, action: null }), ctx).status).toEqual({ label, color });
  });

  it.each([
    ['open', 'Open', 'neutral'],
    ['at_risk', 'At risk', 'warning'],
    ['short_notice', 'Short notice', 'warning'],
    ['last_chance', 'Last chance', 'error'],
    ['missed', 'Missed', 'error'],
  ] as const)('labels urgency %s', (urgency, label, color) => {
    expect(cellView(cup, q4({ urgency }), ctx).urgency).toEqual({ label, color });
  });

  it('shows no urgency once settled, and gives the latest date, with sanction-by while there is time', () => {
    expect(cellView(cup, q4({ status: 'sanctioned', urgency: null, action: null }), ctx)).toMatchObject({ urgency: null, lines: ['Latest date Thu 31 Dec'] });
    expect(cellView(cup, q4(), ctx).lines).toEqual(['Latest date Thu 31 Dec', 'Sanction by Thu 24 Dec']);
    expect(cellView(cup, q4({ urgency: 'short_notice' }), ctx).lines).toEqual(['Latest date Thu 31 Dec']);
  });

  it('lists each covering tournament, and a manual cover with its note, who and when', () => {
    const view = cellView(
      cup,
      q4({
        status: 'covered_manual',
        urgency: null,
        action: null,
        tournaments: [
          { tournamentId: 'g1', plannedId: null, displayId: '26-11-000001', localDate: '2026-11-14', class: 'pending', upstreamStatus: 'approval-pending', organizer: { playerId: '9999991', name: 'Olive' } },
          { tournamentId: null, plannedId: 7, displayId: null, localDate: '2026-12-05', class: 'planned', upstreamStatus: null, organizer: { playerId: '9999992', name: null } },
        ],
        manualCover: { periodStart: '2026-10-01', note: 'Run by Professor X', createdBy: 'organizer', createdAt: '2026-10-02T15:00:00.000Z' },
      }),
      ctx,
    );
    expect(view.lines).toEqual([
      'Latest date Thu 31 Dec',
      '26-11-000001 · Sat 14 Nov · Olive',
      'not in play-tools · Sat 5 Dec · Professor 9999992',
      'Covered by hand: “Run by Professor X” (organizer, 2026-10-02)',
    ]);
    expect(view.actions).toEqual(['uncover']);
  });

  it('names who couldn’t be read for an unknown cell, and the best known status', () => {
    const view = cellView(cup, q4({ status: 'unknown', bestKnown: 'planned', unreadProfessors: [{ playerId: '9999993', name: 'Ash' }] }), {
      ...ctx,
      unread: [{ professor: { playerId: '9999993', name: 'Ash' }, code: 'needs_reconnect', message: 'Reconnect Ash in Settings.' }],
    });
    expect(view.lines.slice(-2)).toEqual(['Couldn’t read Ash’s tournaments: Reconnect Ash in Settings.', 'Best known: Planned, not in play-tools']);
  });

  it('says when play-tools offers no matching series', () => {
    expect(cellView(cup, q4({ noSeries: true }), ctx).lines).toContain('play-tools offers no series matching “League Cup” for TCG this quarter');
  });

  it('offers what fixes the cell', () => {
    expect(cellView(cup, q4(), ctx)).toMatchObject({ actions: ['plan', 'cover'], createPlannedId: null, openText: null });
    expect(cellView(cup, q4({ status: 'planned', action: { kind: 'create', plannedId: 7 } }), ctx)).toMatchObject({ actions: ['create', 'cover'], createPlannedId: 7 });
    const problem = q4({
      status: 'problem',
      action: { kind: 'open_in_play_tools', tournamentId: 'g9' },
      tournaments: [{ tournamentId: 'g9', plannedId: null, displayId: '26-11-000009', localDate: '2026-11-14', class: 'problem', upstreamStatus: 'sanctioning-error', organizer: null }],
    });
    expect(cellView(cup, problem, ctx)).toMatchObject({ actions: ['open', 'cover'], openText: 'Look for 26-11-000009' });
    expect(cellView(cup, q4({ status: 'sanctioned', urgency: null, action: null }), ctx).actions).toEqual([]);
  });

  it('offers no Plan one… once no date in the period can still be created', () => {
    const oct = period({ urgency: 'missed' });
    expect(cellView(requirement(), oct, { ...ctx, today: '2026-11-02' }).actions).toEqual(['plan', 'cover']);
    expect(cellView(requirement(), oct, { ...ctx, today: '2026-11-03' }).actions).toEqual(['cover']);
  });
});

describe('planOneDefaults', () => {
  const cup = requirement({ seriesMatch: 'League Cup', cadence: 'quarter' });
  const q4 = period({ periodStart: '2026-10-01', periodEnd: '2026-12-31', latestDate: '2026-12-31' });
  const templates = [
    template({ id: 1, type: { kind: 'custom' } }),
    template({ id: 2, product: 'pgo', type: { kind: 'premier', seriesMatch: 'League Cup' } }),
    template({ id: 3, archived: true, type: { kind: 'premier', seriesMatch: 'League Cup' } }),
    template({ id: 4, name: 'TCG Cup', type: { kind: 'premier', seriesMatch: 'TCG league cup' } }),
  ];

  it('picks the first matching premier template of the game, and the earliest creatable date in the period', () => {
    expect(planOneDefaults(cup, q4, templates, '2026-11-20')).toEqual({ template: templates[3], date: '2026-11-18' });
    expect(planOneDefaults(cup, q4, templates, '2026-09-15')).toEqual({ template: templates[3], date: '2026-10-01' });
  });

  it('caps the date at the period’s latest date, and offers nothing once it is past the back-dating grace', () => {
    const early = { ...q4, latestDate: '2026-11-30' };
    expect(planOneDefaults(cup, early, templates, '2026-12-02')).toEqual({ template: templates[3], date: '2026-11-30' });
    expect(planOneDefaults(cup, early, templates, '2026-12-03')).toBeNull();
  });

  it('has no template when none matches', () => {
    expect(planOneDefaults(requirement({ product: 'vg' }), period(), templates, '2026-10-14')).toEqual({ template: null, date: '2026-10-12' });
  });
});

function entry(overrides: Partial<UpcomingEntry> = {}): UpcomingEntry {
  return {
    plannedId: 1,
    tournamentId: null,
    scheduleId: null,
    slotPosition: null,
    occurrenceDate: null,
    templateId: 1,
    name: 'Friday Cup',
    localDate: '2026-10-30',
    startTime: '18:00',
    startsAt: '2026-10-30T23:00:00.000Z',
    sanctionBy: '2026-10-23',
    state: 'planned',
    inSchedule: null,
    organizer: { playerId: '9999991', name: 'Olive', connected: true, needsReconnect: false },
    product: 'tcg',
    category: 'tcg_std',
    type: { kind: 'custom' },
    displayId: null,
    upstreamStatus: null,
    errorCode: null,
    lastAttemptAt: null,
    skippedWhileUnknown: false,
    tdfAvailable: false,
    admissionCents: null,
    actions: ['create', 'skip'],
    ...overrides,
  };
}

describe('entryStatus', () => {
  it.each([
    [{ state: 'planned' }, 'Planned', 'neutral'],
    [{ state: 'skipped' }, 'Skipped', 'neutral'],
    [{ state: 'skipped', tournamentId: 'g1' }, 'In play-tools, skipped here', 'warning'],
    [{ state: 'skipped', skippedWhileUnknown: true }, 'Skipped, may be in play-tools', 'warning'],
    [{ state: 'skipped', skippedWhileUnknown: true, tournamentId: 'g1' }, 'In play-tools, skipped here', 'warning'],
    [{ state: 'creating' }, 'Creating…', 'info'],
    [{ state: 'failed', errorCode: 'refused' }, 'Create failed (refused)', 'error'],
    [{ state: 'failed' }, 'Create failed', 'error'],
    [{ state: 'cancelled' }, 'Cancelled', 'neutral'],
    [{ state: 'unknown' }, 'May have been created', 'warning'],
    [{ state: 'created', upstreamStatus: 'approval-pending' }, 'Approval pending', 'info'],
    [{ state: 'upstream', upstreamStatus: 'sanctioning-error' }, 'Sanctioning error', 'error'],
    [{ state: 'created', upstreamStatus: 'cancelled' }, 'Cancelled', 'neutral'],
    [{ state: 'upstream', upstreamStatus: 'complete' }, 'Complete', 'success'],
    [{ state: 'created', upstreamStatus: 'sanctioned' }, 'In play-tools', 'success'],
    [{ state: 'upstream', upstreamStatus: null }, 'In play-tools', 'success'],
  ] as const)('%j → %s', (overrides, label, color) => {
    expect(entryStatus(entry(overrides as Partial<UpcomingEntry>))).toEqual({ label, color });
  });
});

describe('rowActions', () => {
  it("keeps only Download TDF, saying who alone may change it, when another user holds its organizer's connection (ADR-0015 §4)", () => {
    const e = entry({ state: 'created', tournamentId: 'g1', actions: ['skip'], upstreamStatus: 'complete', tdfAvailable: true });
    expect(rowActions(e, 'Only Misty (0000333) can change this')).toEqual({ actions: ['download'], organizerNote: 'Only Misty (0000333) can change this', settings: false });
  });

  it.each([
    ['planned', entry(), ['create', 'skip', 'edit']],
    ['skipped', entry({ state: 'skipped', actions: ['unskip'] }), ['unskip', 'edit']],
    ['skipped here but in play-tools', entry({ state: 'skipped', tournamentId: 'g1', actions: [] }), ['edit', 'cancel']],
    ['creating', entry({ state: 'creating', actions: [] }), []],
    ['unknown', entry({ state: 'unknown', actions: ['skip', 'retry_create'] }), ['skip', 'retry_create']],
    ['skipped while it may have been created', entry({ state: 'skipped', skippedWhileUnknown: true, actions: ['unskip'] }), ['unskip']],
    ['skipped while it may have been created, then linked', entry({ state: 'skipped', skippedWhileUnknown: true, tournamentId: 'g1', actions: ['unskip'] }), ['unskip', 'cancel']],
    ['failed', entry({ state: 'failed', actions: ['create', 'skip'] }), ['create', 'skip', 'edit']],
    ['created', entry({ state: 'created', tournamentId: 'g1', actions: [], upstreamStatus: 'sanctioned' }), ['edit', 'cancel']],
    ['created with results', entry({ state: 'created', tournamentId: 'g1', actions: [], upstreamStatus: 'complete', tdfAvailable: true }), ['edit', 'download']],
    ['cancelled upstream', entry({ state: 'upstream', plannedId: null, tournamentId: 'g1', actions: [], upstreamStatus: 'cancelled' }), []],
    ['cancelled here', entry({ state: 'cancelled', tournamentId: 'g1', actions: [] }), []],
  ] as const)('%s', (_what, e, actions) => {
    expect(rowActions(e)).toEqual({ actions, organizerNote: null, settings: false });
  });

  it('keeps only local actions and the download while the organizer can’t act, and says why', () => {
    const reconnect = entry({ state: 'created', tournamentId: 'g1', actions: [], tdfAvailable: true, organizer: { playerId: '9999991', name: 'Olive', connected: true, needsReconnect: true } });
    expect(rowActions(reconnect)).toEqual({ actions: ['download'], organizerNote: 'Reconnect Olive in Settings to change this tournament.', settings: true });
    const gone = entry({ organizer: { playerId: '9999992', name: null, connected: false, needsReconnect: false } });
    expect(rowActions(gone)).toEqual({ actions: ['skip'], organizerNote: 'Connect Professor 9999992’s Pokémon account in Settings to change this tournament.', settings: true });
    expect(rowActions(entry({ organizer: null }))).toMatchObject({ actions: ['skip'], settings: true });
    const unknown = entry({ state: 'unknown', actions: ['skip'], organizer: { playerId: '9999992', name: null, connected: false, needsReconnect: false } });
    expect(rowActions(unknown).actions).toEqual(['skip']);
    const held = entry({ state: 'skipped', skippedWhileUnknown: true, tournamentId: 'g1', actions: ['unskip'], organizer: null });
    expect(rowActions(held).actions).toEqual(['unskip']);
  });
});

describe('sanctionTag', () => {
  const today = '2026-10-14';
  it.each([
    [entry({ localDate: '2026-10-30', sanctionBy: '2026-10-23' }), 'Create by Fri 23 Oct'],
    [entry({ localDate: '2026-10-18', sanctionBy: '2026-10-11' }), 'Short notice'],
    [entry({ localDate: '2026-10-13', sanctionBy: '2026-10-06' }), 'Back-dated'],
    [entry({ state: 'unknown', localDate: '2026-10-30', sanctionBy: '2026-10-23' }), 'Create by Fri 23 Oct'],
    [entry({ state: 'created', tournamentId: 'g1' }), null],
    [entry({ state: 'skipped' }), null],
  ] as const)('%#', (e, tag) => {
    expect(sanctionTag(e, today)).toBe(tag);
  });
});

describe('groupByDate', () => {
  it('groups by league date, keeping the server’s order', () => {
    const a = entry({ plannedId: 1, localDate: '2026-10-16' });
    const b = entry({ plannedId: 2, localDate: '2026-10-16', startTime: '19:00' });
    const c = entry({ plannedId: 3, localDate: '2026-10-20' });
    expect(groupByDate([a, b, c])).toEqual([
      { date: '2026-10-16', heading: 'Fri 16 Oct', entries: [a, b] },
      { date: '2026-10-20', heading: 'Tue 20 Oct', entries: [c] },
    ]);
  });
});

describe('retryContext', () => {
  it('gives when the earlier create was sent and the organizer’s other play-tools tournaments that day', () => {
    const unknown = entry({ plannedId: 5, state: 'unknown', lastAttemptAt: '2026-10-14T17:05:00.000Z', localDate: '2026-10-30' });
    const sameDay = entry({ plannedId: null, state: 'upstream', tournamentId: 'g1', localDate: '2026-10-30' });
    const linked = entry({ plannedId: 6, state: 'created', tournamentId: 'g2', localDate: '2026-10-30' });
    const otherOrganizer = entry({ plannedId: null, state: 'upstream', tournamentId: 'g3', localDate: '2026-10-30', organizer: { playerId: '9999992', name: 'Brock', connected: true, needsReconnect: false } });
    const otherDay = entry({ plannedId: null, state: 'upstream', tournamentId: 'g4', localDate: '2026-10-31' });
    const planned = entry({ plannedId: 7, localDate: '2026-10-30' });
    expect(retryContext(unknown, [unknown, sameDay, linked, otherOrganizer, otherDay, planned], [])).toEqual({
      sentAt: '2026-10-14T17:05:00.000Z',
      sameDay: [sameDay, linked],
      blocked: null,
    });
  });

  it('blocks the retry when the organizer’s tournaments couldn’t be read, or the fresh read linked it', () => {
    const unknown = entry({ plannedId: 5, state: 'unknown', lastAttemptAt: '2026-10-14T17:05:00.000Z' });
    const unread = [{ professor: { playerId: '9999991', name: 'Olive' }, code: 'unavailable', message: 'down' }];
    expect(retryContext(unknown, [unknown], unread).blocked).toBe('Couldn’t read Olive’s tournaments from play-tools, so a retry could make a duplicate. Try again later.');
    expect(retryContext(unknown, [unknown], [{ ...unread[0]!, professor: { playerId: '9999992', name: 'Brock' } }]).blocked).toBeNull();
    const landed = { ...unknown, state: 'created' as const, tournamentId: 'g1' };
    expect(retryContext(landed, [landed], []).blocked).toBe('It landed in play-tools: nothing to retry.');
  });
});

describe('upcomingNotice', () => {
  it('says why play-tools wasn’t read, and warns per unread professor', () => {
    expect(upcomingNotice({ upstream: 'not_connected', unread: [] })).toEqual({ settingsNote: 'Connect a Pokémon account in Settings to see play-tools’ tournaments.', warnings: [] });
    expect(upcomingNotice({ upstream: 'league_not_selected', unread: [] }).settingsNote).toBe('Choose a league in Settings to see play-tools’ tournaments.');
    expect(
      upcomingNotice({
        upstream: 'read',
        unread: [
          { professor: { playerId: '9999993', name: 'Ash' }, code: 'needs_reconnect', message: 'x' },
          { professor: { playerId: '9999992', name: 'Brock' }, code: 'unavailable', message: 'down' },
        ],
      }),
    ).toEqual({
      settingsNote: null,
      warnings: [
        { text: 'Reconnect Ash in Settings to see their tournaments.', settings: true, retry: false },
        { text: "Couldn't read Brock's tournaments from play-tools.", settings: false, retry: true },
      ],
    });
  });
});

describe('outcomeLabel', () => {
  it.each([
    ['pending', 'Waiting'],
    ['created', 'Created'],
    ['already_exists', 'Already in play-tools (linked)'],
    ['refused', 'Refused by play-tools'],
    ['failed', 'Failed'],
    ['skipped', 'Not sent'],
    ['unknown', 'May have been created'],
    ['date_too_far_past', 'Too far in the past'],
    ['date_too_far_ahead', 'Too far ahead'],
    ['edited', 'Edited'],
    ['already_applied', 'Already up to date'],
    ['cancelled', 'Cancelled'],
    ['already_cancelled', 'Already cancelled'],
    ['processing', 'Processing in play-tools'],
    ['uploaded', 'Uploaded'],
    ['not_accepted', 'Not accepted by play-tools'],
    ['warnings_changed', 'Warnings changed; nothing sent'],
    ['validate_unknown', 'May have been sent'],
    ['processing_failed', 'play-tools couldn’t process it'],
  ] as const)('%s → %s', (outcome, label) => {
    expect(outcomeLabel(outcome)).toBe(label);
  });
});

describe('supportText', () => {
  const support: SupportDetails = {
    action: 'create',
    sentAt: '2026-10-14T17:05:00.000Z',
    league: { displayId: 'L5012' },
    tournament: { displayId: null, name: 'Friday Cup', date: '2026-10-30' },
    professor: { playerId: '9999991', name: 'Olive' },
    status: 403,
    code: null,
    message: 'Forbidden',
    correlationId: 'corr-1',
  };

  it('holds exactly what support needs, one line each', () => {
    expect(supportText(support)).toBe(
      [
        'Action: create',
        'Sent: 2026-10-14T17:05:00.000Z',
        'League: L5012',
        'Tournament: (not created) · Friday Cup · 2026-10-30',
        'Professor: Olive (9999991)',
        'HTTP status: 403',
        'play-tools code: —',
        'play-tools message: Forbidden',
        'Correlation id: corr-1',
      ].join('\n'),
    );
  });

  it('adds an upload’s id and errors when it has them, and nothing else', () => {
    const text = supportText({ ...support, action: 'upload', uploadGuid: 'u-1', errors: ['E1', 'E2'], tournament: { displayId: '26-10-1', name: 'Cup', date: '2026-10-30' } });
    expect(text.split('\n').slice(-2)).toEqual(['Upload id: u-1', 'Errors: E1, E2']);
    const extra = { ...support, token: 'secret', authorization: 'Bearer x' } as SupportDetails;
    expect(supportText(extra)).not.toMatch(/secret|Bearer/);
  });
});

describe('leftOutText', () => {
  it.each([
    ['skipped', 'Skipped'],
    ['in_play_tools', 'Already in play-tools'],
    ['creating', 'Being created'],
    ['unknown', 'May have been created'],
    ['before_window', 'Before the creatable window'],
  ] as const)('%s → %s', (reason, text) => {
    expect(leftOutText(reason)).toBe(text);
  });
});

describe('createThroughView', () => {
  const preview = (o: Partial<CreateThroughPreview> = {}): CreateThroughPreview => ({
    scheduleId: 1,
    scaffoldName: 'Fridays',
    from: '2026-10-12',
    through: '2026-12-31',
    tournaments: [{ ...entry({ localDate: '2026-10-30' }), shortNotice: false }],
    leftOut: [],
    count: 1,
    tooMany: false,
    suggestedThrough: null,
    unread: [],
    ...o,
  });

  it('confirms the count, or Create anyway with short notice', () => {
    expect(createThroughView(preview())).toEqual({ confirmLabel: 'Create 1 tournament', disabledReason: null, suggestedThrough: null, shortNotice: 0 });
    const soon = preview({ count: 2, tournaments: [{ ...entry(), shortNotice: true }, { ...entry(), shortNotice: false }] });
    expect(createThroughView(soon)).toMatchObject({ confirmLabel: 'Create anyway', shortNotice: 1 });
  });

  it('blocks more than 60 and suggests a date, and has nothing to confirm with none', () => {
    expect(createThroughView(preview({ tooMany: true, count: 61, suggestedThrough: '2026-12-11' }))).toEqual({
      confirmLabel: null,
      disabledReason: '61 tournaments is more than 60 at a time.',
      suggestedThrough: '2026-12-11',
      shortNotice: 0,
    });
    expect(createThroughView(preview({ count: 0, tournaments: [] }))).toMatchObject({ confirmLabel: null, disabledReason: 'Nothing to create through this date.' });
  });
});

describe('cancelConfirmed', () => {
  it('needs the display id typed exactly, ignoring spaces around it', () => {
    expect(cancelConfirmed(' 26-10-1 ', '26-10-1')).toBe(true);
    expect(cancelConfirmed('26-10-', '26-10-1')).toBe(false);
    expect(cancelConfirmed('26-10-1'.toUpperCase(), '26-10-1')).toBe(true);
    expect(cancelConfirmed('', null)).toBe(true);
  });
});

describe('downloadName', () => {
  it.each([
    ['attachment; filename="cup.tdf"', 'cup.tdf'],
    [`attachment; filename="cup.tdf"; filename*=UTF-8''Pok%C3%A9mon%20Cup.tdf`, 'Pokémon Cup.tdf'],
    [`attachment; filename*=UTF-8''%E0%A4%A`, '26-10-1.tdf'],
    ['inline', '26-10-1.tdf'],
    [null, '26-10-1.tdf'],
  ] as const)('%j → %s', (header, name) => {
    expect(downloadName(header, '26-10-1')).toBe(name);
  });

  it('falls back to a plain name without a display id', () => {
    expect(downloadName(null, null)).toBe('tournament.tdf');
  });
});

describe('the edit form', () => {
  const values: EditValues = {
    name: 'Friday Cup',
    category: 'tcg_std',
    venue: { id: 'v1', label: 'Card Shop', timeZone: 'America/Chicago', country: 'US' },
    localDate: '2026-10-30',
    startTime: '18:00',
    registration: { kind: 'on_site', opensBeforeMin: 60, closesAfterMin: 15, admissionCents: null },
    contactEmail: 'league@example.com',
    contactPhone: null,
    details: null,
    eventWebsite: null,
  };

  it('sends only the fields that changed, comparing the venue by id and blank text as empty', () => {
    const form: EditValues = {
      ...values,
      name: 'Friday Cup November',
      venue: { id: 'v1', label: 'Card Shop (renamed)', timeZone: 'America/Chicago', country: 'US' },
      registration: { kind: 'on_site', opensBeforeMin: 60, closesAfterMin: 15, admissionCents: null },
      contactPhone: '  ',
      details: 'Bring a deck box',
    };
    expect(changedValues(values, form)).toEqual({ name: 'Friday Cup November', details: 'Bring a deck box' });
    expect(changedValues(values, { ...values })).toEqual({});
    expect(changedValues(values, { ...values, venue: { ...values.venue, id: 'v2' } })).toEqual({ venue: { ...values.venue, id: 'v2' } });
  });

  it('ticks every changed field to carry over except the name, and never offers the date', () => {
    expect(defaultTicks(['name', 'details', 'venue', 'localDate'])).toEqual(['venue', 'details']);
  });

  it('shows a field’s before and after in words', () => {
    expect(valueText('venue', values.venue)).toBe('Card Shop');
    expect(valueText('registration', values.registration)).toBe('On site: opens 60 min before, closes 15 min after');
    expect(valueText('registration', { kind: 'on_site', opensBeforeMin: 30, closesAfterMin: 0, admissionCents: 500 })).toBe(
      'On site: opens 30 min before, closes 0 min after, admission $5',
    );
    expect(valueText('registration', { kind: 'on_site', opensBeforeMin: 30, closesAfterMin: 0, admissionCents: 0 })).toBe(
      'On site: opens 30 min before, closes 0 min after, admission Free',
    );
    expect(valueText('registration', { kind: 'third_party', url: 'https://example.com/r' })).toBe('Third party: https://example.com/r');
    expect(valueText('details', null)).toBe('—');
    expect(valueText('startTime', '18:00')).toBe('18:00');
    expect(FIELD_LABEL.contactEmail).toBe('Contact email');
  });

  it('excludes the preview entries the organizer unticked', () => {
    expect(excludedKeys([{ key: 'p:1' }, { key: 'p:2' }, { key: 't:g3' }], new Set(['p:1', 't:g3']))).toEqual(['p:2']);
  });
});

describe('the template form', () => {
  const options: TournamentOptions = {
    types: [
      { kind: 'custom' },
      { kind: 'premier', seriesId: 's1', name: 'League Challenge November', product: 'tcg', categories: ['tcg_std'], window: { from: '2026-11-01', to: '2026-11-30' } },
    ],
    formats: [{ product: 'tcg', categories: ['tcg_std', 'tcg_exp'] }],
    venues: [
      { id: 'v1', label: 'Card Shop', country: 'US', timeZone: 'America/Chicago' },
      { id: 'v2', label: 'Library', country: null, timeZone: null },
    ],
  };

  it('offers Custom first, then each series by name, which sets the match and the game', () => {
    expect(templateTypeChoices(options)).toEqual([
      { label: 'Custom', value: { kind: 'custom' } },
      { label: 'League Challenge November', value: { kind: 'premier', seriesMatch: 'League Challenge November' }, product: 'tcg' },
    ]);
  });

  it('fills a venue’s missing time zone and country from the league and the options’ country', () => {
    expect(venueValue(options.venues[1]!, 'America/Chicago')).toEqual({ id: 'v2', label: 'Library', timeZone: 'America/Chicago', country: 'US' });
    expect(venueValue(options.venues[0]!, 'Europe/London')).toEqual({ id: 'v1', label: 'Card Shop', timeZone: 'America/Chicago', country: 'US' });
  });

  it('keeps a saved venue selectable when play-tools no longer lists it, or can’t be read', () => {
    const saved = { id: 'gone', label: 'Old Shop', timeZone: 'America/Chicago', country: 'US' };
    expect(venueChoices(options, saved).map((v) => v.id)).toEqual(['gone', 'v1', 'v2']);
    expect(venueChoices(options, { ...saved, id: 'v1' }).map((v) => v.id)).toEqual(['v1', 'v2']);
    expect(venueChoices(null, saved).map((v) => v.id)).toEqual(['gone']);
    expect(venueChoices(null, null)).toEqual([]);
  });

  it('sends blank optional text as empty, since the server checks an email or URL that is there', () => {
    expect(blankToNull('  ')).toBeNull();
    expect(blankToNull('')).toBeNull();
    expect(blankToNull(null)).toBeNull();
    expect(blankToNull(' a@b.c ')).toBe('a@b.c');
  });

  it('says what stops it saving', () => {
    const form: TemplateFormState = {
      name: 'Friday Cup',
      organizerPlayerId: '9999991',
      category: 'tcg_std',
      venue: { id: 'v1', label: 'Card Shop', timeZone: 'America/Chicago', country: 'US' },
      contactEmail: 'league@example.com',
      contactPhone: '',
      optionsLoaded: true,
      editing: false,
    };
    expect(templateFormProblem(form)).toBeNull();
    expect(templateFormProblem({ ...form, contactEmail: ' ', contactPhone: '' })).toBe('Add a contact email or phone');
    expect(templateFormProblem({ ...form, optionsLoaded: false })).toBe('Waiting for play-tools’ choices');
    expect(templateFormProblem({ ...form, optionsLoaded: false, editing: true })).toBeNull();
    expect(templateFormProblem({ ...form, name: '  ' })).toBe('Name the template');
    expect(templateFormProblem({ ...form, organizerPlayerId: '' })).toBe('Choose the organizer');
    expect(templateFormProblem({ ...form, venue: null })).toBe('Choose a venue');
    expect(templateFormProblem({ ...form, category: '' })).toBe('Choose a format');
  });
});

describe('requirementPatch', () => {
  it('sends only what changed', () => {
    const before = requirement();
    expect(requirementPatch(before, { ...before, cadence: 'quarter' })).toEqual({ cadence: 'quarter' });
    expect(requirementPatch(before, { ...before, warnDays: 30, active: false })).toEqual({ warnDays: 30, active: false });
    expect(requirementPatch(before, { ...before })).toEqual({});
  });
});

describe('tabFromQuery', () => {
  it.each([
    ['required', 'required'],
    ['templates', 'templates'],
    ['schedules', 'schedules'],
    ['upcoming', 'upcoming'],
    ['nonsense', 'upcoming'],
    [undefined, 'upcoming'],
    [['schedules'], 'upcoming'],
  ] as const)('%j → %s', (q, tab) => {
    expect(tabFromQuery(q)).toBe(tab);
  });
});

describe('the Tournaments tabs (#162)', () => {
  it('lists Upcoming, Required events, Templates and Schedules, in that order', () => {
    expect(tournamentsTabs(0).map((t) => [t.value, t.label])).toEqual([
      ['upcoming', 'Upcoming'],
      ['required', 'Required events'],
      ['templates', 'Templates'],
      ['schedules', 'Schedules'],
    ]);
  });

  it('puts the count of required events needing attention on their tab, in its accessible name too', () => {
    expect(tournamentsTabs(3)[1]).toEqual({ value: 'required', label: 'Required events', badge: '3', ariaLabel: 'Required events, 3 need attention' });
    expect(tournamentsTabs(1)[1]!.ariaLabel).toBe('Required events, 1 needs attention');
    expect(tournamentsTabs(0)[1]).toEqual({ value: 'required', label: 'Required events' });
  });

  it('keeps Upcoming out of the URL', () => {
    expect(tabQuery({ tab: 'templates', from: 'x' }, 'upcoming')).toEqual({ from: 'x' });
    expect(tabQuery({}, 'required')).toEqual({ tab: 'required' });
  });
});

describe('bannerLines', () => {
  const ash = { playerId: '1111111', name: 'Professor Ash' };
  const lc = (product: Requirement['product'], id: number) => requirement({ id, product, seriesMatch: 'League Challenge', cadence: 'month' });
  const coverage = (rows: { requirement: Requirement; periods: PeriodCoverage[] }[], unread: RequiredEventsCoverage['unread'] = []): RequiredEventsCoverage => ({
    timeZone: 'America/Chicago',
    today: '2026-11-02',
    country: 'US',
    upstream: 'read',
    unread,
    seriesUnavailable: false,
    requirements: rows,
  });
  const unreadAsh = { professor: ash, code: 'needs_reconnect' as const, message: 'Reconnect Professor Ash in Settings.' };
  const covered = coverage(
    [
      {
        requirement: lc('tcg', 1),
        periods: [
          period({ periodStart: '2026-09-01', periodEnd: '2026-09-30', latestDate: '2026-09-30', sanctionBy: '2026-09-23', urgency: 'missed' }),
          period({ periodStart: '2026-10-01', periodEnd: '2026-10-31', latestDate: '2026-10-31', sanctionBy: '2026-10-24', urgency: 'last_chance' }),
          period({ periodStart: '2026-11-01', periodEnd: '2026-11-30', latestDate: '2026-11-30', sanctionBy: '2026-11-23', urgency: 'open' }),
        ],
      },
      {
        requirement: lc('pgo', 2),
        periods: [
          period({ periodStart: '2026-10-01', periodEnd: '2026-10-31', latestDate: '2026-10-31', status: 'sanctioned', urgency: null }),
          period({ periodStart: '2026-11-01', periodEnd: '2026-11-30', latestDate: '2026-11-30', sanctionBy: '2026-11-23', status: 'planned', urgency: 'at_risk' }),
        ],
      },
      {
        requirement: lc('vg', 3),
        periods: [
          period({ periodStart: '2026-11-01', periodEnd: '2026-11-30', latestDate: '2026-11-07', sanctionBy: '2026-10-31', urgency: 'short_notice' }),
          period({
            periodStart: '2026-12-01',
            periodEnd: '2026-12-31',
            latestDate: '2026-12-31',
            sanctionBy: '2026-12-24',
            status: 'problem',
            urgency: 'open',
            tournaments: [{ tournamentId: 'g9', plannedId: null, displayId: '26-12-000001', localDate: '2026-12-12', class: 'problem', upstreamStatus: 'sanctioning-error', organizer: null }],
          }),
        ],
      },
      {
        requirement: requirement({ id: 4, seriesMatch: 'League Cup', product: 'tcg', cadence: 'quarter' }),
        periods: [
          period({
            periodStart: '2026-10-01',
            periodEnd: '2026-12-31',
            latestDate: '2026-12-31',
            sanctionBy: '2026-12-24',
            status: 'unknown',
            bestKnown: 'missing',
            urgency: 'at_risk',
            unreadProfessors: [ash],
          }),
        ],
      },
    ],
    [unreadAsh],
  );

  it('gives one line per cell at risk or louder, or with a sanctioning error, most urgent first, then each unread professor', () => {
    expect(bannerLines(covered, '2026-11-02')).toEqual([
      { text: 'Missed: no League Challenge for TCG in Sep 2026. The last date was Wed 30 Sep.', tone: 'error', action: null },
      { text: 'Last chance for a League Challenge for TCG in Oct 2026: a tournament held Sat 31 Oct to Sat 31 Oct can still be sanctioned.', tone: 'error', action: null },
      {
        text: 'A League Challenge for VGC in Nov 2026 is short notice (Missing): the sanction-by date, Sat 31 Oct, has passed. A tournament up to Sat 7 Nov can still be sanctioned.',
        tone: 'warning',
        action: null,
      },
      { text: 'A League Challenge for GO in Nov 2026 is at risk (Planned, not in play-tools). Sanction by Mon 23 Nov; the last date is Mon 30 Nov.', tone: 'warning', action: null },
      { text: 'Can’t confirm a League Cup for TCG in Q4 2026: Professor Ash’s tournaments (needs reconnect) couldn’t be read. The last date is Thu 31 Dec.', tone: 'warning', action: null },
      { text: '26-12-000001 has a sanctioning error in play-tools: it doesn’t cover a League Challenge for VGC in Dec 2026.', tone: 'error', action: null },
      { text: 'Couldn’t read Professor Ash’s tournaments: Reconnect Professor Ash in Settings.', tone: 'warning', action: 'reconnect' },
    ]);
  });

  it('names an unreadable tournament when no professor is to blame, and offers Retry for a failed read', () => {
    const c = coverage(
      [{ requirement: lc('tcg', 1), periods: [period({ status: 'unknown', urgency: 'missed', latestDate: '2026-09-30', unreadTournaments: [{ tournamentId: 'g1', displayId: null }] })] }],
      [{ professor: { playerId: '2222222', name: null }, code: 'upstream_unavailable', message: 'play-tools is unavailable.' }],
    );
    expect(bannerLines(c, '2026-11-02')).toEqual([
      { text: 'Can’t confirm a League Challenge for TCG in Oct 2026: a tournament’s details couldn’t be read. The last date is Wed 30 Sep.', tone: 'error', action: null },
      { text: 'Couldn’t read Professor 2222222’s tournaments: play-tools is unavailable.', tone: 'warning', action: 'retry' },
    ]);
  });

  it('is empty while nothing needs attention', () => {
    expect(bannerLines(coverage([{ requirement: lc('tcg', 1), periods: [period({ urgency: 'open' }), period({ status: 'sanctioned', urgency: null })] }]), '2026-11-02')).toEqual([]);
  });
});

describe('upcomingQuery', () => {
  it('reads one date range, and lists play-tools again for a fresh read, both together for a retry from This week', () => {
    expect(upcomingQuery({})).toEqual({});
    expect(upcomingQuery({ upstream: true })).toEqual({ refresh: '1' });
    expect(upcomingQuery({ range: { from: '2026-10-30', to: '2026-10-30' } })).toEqual({ from: '2026-10-30', to: '2026-10-30' });
    expect(upcomingQuery({ upstream: true, range: { from: '2026-10-30', to: '2026-10-30' } })).toEqual({ from: '2026-10-30', to: '2026-10-30', refresh: '1' });
  });
});

describe('New tournament with details changed from the template (#162)', () => {
  const premierTemplate = template({ name: 'League Challenge {month}', type: { kind: 'premier', seriesMatch: 'League Challenge' } });
  const NOV = { kind: 'premier' as const, seriesId: 'lc-nov', name: 'League Challenge November', product: 'tcg', categories: ['tcg_std'], window: { from: '2026-11-01', to: '2026-11-30' } };
  const options: TournamentOptions = {
    types: [
      { kind: 'custom' },
      NOV,
      { kind: 'premier', seriesId: 'cup-q4', name: 'League Cup Q4', product: 'tcg', categories: ['tcg_std', 'tcg_exp'], window: { from: '2026-10-01', to: '2026-12-31' } },
      { kind: 'premier', seriesId: 'go-nov', name: 'League Challenge November', product: 'pgo', categories: ['go_std'], window: { from: '2026-11-01', to: '2026-11-30' } },
    ],
    formats: [
      { product: 'tcg', categories: ['tcg_std', 'tcg_exp'] },
      { product: 'pgo', categories: ['go_std'] },
    ],
    venues: [{ id: 'v1', label: 'Card Shop', country: 'US', timeZone: 'America/Chicago' }],
  };

  it('pre-fills every detail from the template, the name with its tokens, the type as the template’s', () => {
    const t = premierTemplate;
    expect(detailsFromTemplate({ ...t, details: 'Bring a deck', contactPhone: null })).toEqual({
      name: 'League Challenge {month}',
      typeKey: AS_TEMPLATE,
      category: 'tcg_std',
      venue: t.venue,
      registration: t.registration,
      contactEmail: 'league@example.com',
      contactPhone: '',
      details: 'Bring a deck',
      eventWebsite: '',
    });
  });

  describe('what Plan tournament sends', () => {
    const base = detailsFromTemplate(premierTemplate);

    it('sends nothing over the template when nothing changed', () => {
      expect(newTournamentChanges(base, structuredClone(base))).toEqual({ overrides: {}, count: 0 });
    });

    it('sends only what changed, a cleared field as null', () => {
      const form = { ...structuredClone(base), name: 'Halloween Cup', contactEmail: '  ', details: 'Costumes welcome' };
      expect(newTournamentChanges(base, form)).toEqual({ overrides: { name: 'Halloween Cup', contactEmail: null, details: 'Costumes welcome' }, count: 3 });
    });

    it('judges a change on meaning: a venue by id, registration by fields, blank as empty', () => {
      const form = {
        ...structuredClone(base),
        venue: { ...base.venue, label: 'Card Shop (renamed)', timeZone: 'America/New_York' },
        registration: { kind: 'on_site' as const, closesAfterMin: 15, opensBeforeMin: 60, admissionCents: null },
        name: ' League Challenge {month} ',
        eventWebsite: '   ',
      };
      expect(newTournamentChanges(base, form)).toEqual({ overrides: {}, count: 0 });
    });

    it('sends a new venue and a new registration whole', () => {
      const hall = { id: 'v2', label: 'Hall', timeZone: 'America/Chicago', country: 'US' };
      const online = { kind: 'third_party' as const, url: 'https://tickets.example.com' };
      expect(newTournamentChanges(base, { ...structuredClone(base), venue: hall, registration: online })).toEqual({ overrides: { venue: hall, registration: online }, count: 2 });
    });

    it.each([
      [AS_TEMPLATE, undefined, 0],
      ['custom', 'custom', 1],
      ['lc-nov', 'lc-nov', 1],
    ])('a type of %s sends seriesId %s', (typeKey, seriesId, count) => {
      expect(newTournamentChanges(base, { ...structuredClone(base), typeKey })).toEqual({ overrides: {}, ...(seriesId && { seriesId }), count });
    });
  });

  describe('the type choices for the date', () => {
    it('on a premier template: as the template, Custom, then the game’s series offered that day', () => {
      expect(newTournamentTypeChoices(premierTemplate, options, '2026-11-20')).toEqual([
        { value: AS_TEMPLATE, label: 'League Challenge (resolved for the date)' },
        { value: 'custom', label: 'Custom' },
        { value: 'lc-nov', label: 'League Challenge November' },
        { value: 'cup-q4', label: 'League Cup Q4' },
      ]);
      expect(newTournamentTypeChoices(premierTemplate, options, '2026-10-20').map((c) => c.value)).toEqual([AS_TEMPLATE, 'custom', 'cup-q4']);
    });

    it('on a custom template: one Custom, which is the template’s, then the series', () => {
      const choices = newTournamentTypeChoices(template(), options, '2026-11-20');
      expect(choices).toEqual([
        { value: AS_TEMPLATE, label: 'Custom' },
        { value: 'lc-nov', label: 'League Challenge November' },
        { value: 'cup-q4', label: 'League Cup Q4' },
      ]);
      expect(choices.filter((c) => c.label === 'Custom')).toHaveLength(1);
    });

    it('offers only the template’s own type when play-tools’ choices couldn’t be read', () => {
      expect(newTournamentTypeChoices(premierTemplate, null, '2026-11-20')).toEqual([{ value: AS_TEMPLATE, label: 'League Challenge (resolved for the date)' }]);
      expect(newTournamentTypeChoices(template(), null, '2026-11-20')).toEqual([{ value: AS_TEMPLATE, label: 'Custom' }]);
    });

    it('keeps a picked series only while its window holds the date', () => {
      expect(typeStillOffered('lc-nov', options, '2026-11-30')).toBe(true);
      expect(typeStillOffered('lc-nov', options, '2026-12-01')).toBe(false);
      expect(typeStillOffered('go-nov', options, '2026-11-20')).toBe(true);
      expect(typeStillOffered('withdrawn', options, '2026-11-20')).toBe(false);
      expect(typeStillOffered(AS_TEMPLATE, options, '2026-12-01')).toBe(true);
      expect(typeStillOffered('custom', null, '2026-12-01')).toBe(true);
    });
  });

  describe('the format choices', () => {
    it('follows a picked series, or the game’s formats for Custom', () => {
      expect(newTournamentFormats(premierTemplate, 'lc-nov', options, '2026-11-20')).toEqual({ formats: ['tcg_std'], note: null });
      expect(newTournamentFormats(premierTemplate, 'custom', options, '2026-11-20')).toEqual({ formats: ['tcg_std', 'tcg_exp'], note: null });
      expect(newTournamentFormats(template(), AS_TEMPLATE, options, '2026-11-20')).toEqual({ formats: ['tcg_std', 'tcg_exp'], note: null });
    });

    it('for a premier template left as it is, the formats of the series it resolves to that day', () => {
      expect(newTournamentFormats(premierTemplate, AS_TEMPLATE, options, '2026-11-20')).toEqual({ formats: ['tcg_std'], note: null });
    });

    it.each([
      ['none resolves', '2026-12-04', options],
      ['two resolve', '2026-11-20', { ...options, types: [...options.types, { ...NOV, seriesId: 'lc-nov-2', name: 'League Challenge November B' }] }],
    ])('falls back to the game’s formats, with a note, when %s', (_, date, o) => {
      expect(newTournamentFormats(premierTemplate, AS_TEMPLATE, o, date)).toEqual({
        formats: ['tcg_std', 'tcg_exp'],
        note: `No single League Challenge series for ${dayLabel(date)}; check the format when you create it.`,
      });
    });

    it('offers only the template’s format when play-tools’ choices couldn’t be read', () => {
      expect(newTournamentFormats(premierTemplate, AS_TEMPLATE, null, '2026-11-20')).toEqual({ formats: ['tcg_std'], note: null });
    });
  });

  it.each([
    ['already_planned', 'That tournament is already planned for this date and time. Change it with Edit… instead.'],
    ['template_archived', '“Friday Cup” is archived. Choose another template.'],
    ['contact_required', 'Give this tournament a contact email or phone.'],
    ['something_else', null],
  ])('explains %s', (code, text) => {
    expect(plannedErrorText(code, 'Friday Cup')).toBe(text);
  });
});

describe('the Admission input', () => {
  it.each([
    ['10', 1000],
    ['$7.5', 750],
    ['Free', 0],
    ['', null],
    ['  ', null],
  ])('reads %j as %j', (text, cents) => {
    expect(admissionInput(text)).toBe(cents);
  });

  it("marks text that isn't an amount so the form can refuse it", () => {
    expect(admissionInput('abc')).toBeNaN();
    expect(admissionInput('1000.00')).toBeNaN();
  });

  it('shows a stored amount as text that reads back the same', () => {
    expect(admissionInputText(null)).toBe('');
    expect(admissionInputText(0)).toBe('Free');
    expect(admissionInputText(750)).toBe('7.50');
    expect(admissionInput(admissionInputText(750))).toBe(750);
  });

  it('refuses to save a registration whose admission is not an amount', () => {
    const window = { kind: 'on_site', opensBeforeMin: 60, closesAfterMin: 15 } as const;
    expect(registrationProblem({ ...window, admissionCents: Number.NaN })).toBe('Enter an amount such as 10 or 7.50');
    expect(registrationProblem({ ...window, admissionCents: 750 })).toBeNull();
    expect(registrationProblem({ ...window, admissionCents: null })).toBeNull();
    expect(registrationProblem({ kind: 'third_party', url: 'https://tickets.example.com' })).toBeNull();
    expect(registrationProblem(null)).toBeNull();
  });
});

describe('a tournament row’s start line', () => {
  it('puts the admission after the start time, and nothing when there is none', () => {
    expect(startLine('10:00', 1000)).toBe('10:00 · $10');
    expect(startLine('10:00', 0)).toBe('10:00 · Free');
    expect(startLine('10:00', null)).toBe('10:00');
  });
});
