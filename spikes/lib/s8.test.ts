import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type Plan,
  type PlanEvent,
  type TournamentDetail,
  buildTemplate,
  cancelRefusal,
  confirmCode,
  createBody,
  knownOriginalsFrom,
  localToUtc,
  maskIds,
  restoreActions,
  tdfMismatch,
  validatePlan,
} from './s8';

const NOW = new Date('2026-10-13T15:40:00Z');

function planEvent(over: Partial<PlanEvent> = {}): PlanEvent {
  return { name: "Ettin's TCG Practice Tournament", product: 'tcg', category: 'tcg_std', series_guid: null, local_start: '2026-10-12T10:00', ...over };
}

function plan(events: PlanEvent[] = [planEvent()], over: Partial<Plan['template']> = {}): Plan {
  return {
    template: {
      activity_group_id: 'ag-guid',
      organizer_id: 'organizer-guid',
      address_id: 'address-guid',
      timezone: 'America/Chicago',
      contact_information: { email: 'league@example.com' },
      ...over,
    },
    categories: { tcg: ['tcg_std', 'tcg_exp'], vg: ['vg_mod'], pgo: ['pgo_std'] },
    series: [],
    events,
  };
}

describe('validatePlan', () => {
  it('accepts one custom TCG event 24 h back with every field valid', () => {
    expect(validatePlan(plan(), { now: NOW })).toEqual([]);
  });

  it('lists every problem with its event and field', () => {
    const bad = planEvent({ name: 'x'.repeat(81), category: 'vg_mod', local_start: '2026-10-10T09:00', series_guid: 'series-guid' });
    const problems = validatePlan(plan([bad, planEvent()], { contact_information: {} }), { now: NOW });

    expect(problems.map((p) => `${p.index}:${p.field}`)).toEqual([
      'plan:events',
      '0:name',
      '0:category',
      '0:series_guid',
      '0:local_start',
      '0:contact_information',
      '1:contact_information',
    ]);
  });

  it.each([
    ['an empty name', { name: '  ' }, 'name'],
    ['an emoji in the name', { name: 'League ⚡ night' }, 'name'],
    ['an unknown product', { product: 'mtg' as PlanEvent['product'] }, 'product'],
    ['details over 30,000 characters', { details: 'x'.repeat(30_001) }, 'details'],
    ['a malformed start', { local_start: '12/10/2026 10:00' }, 'local_start'],
  ])('refuses %s', (_label, over, field) => {
    expect(validatePlan(plan([planEvent(over)]), { now: NOW }).map((p) => p.field)).toEqual([field]);
  });

  it('allows a start exactly 72 h back and refuses one a minute earlier', () => {
    // 2026-10-10T10:40 CDT = 15:40Z, exactly 72 h before NOW.
    expect(validatePlan(plan([planEvent({ local_start: '2026-10-10T10:40' })]), { now: NOW })).toEqual([]);
    expect(validatePlan(plan([planEvent({ local_start: '2026-10-10T10:39' })]), { now: NOW }).map((p) => p.field)).toEqual(['local_start']);
  });

  it('accepts a phone instead of an email', () => {
    expect(validatePlan(plan([planEvent()], { contact_information: { phone: '555-0100' } }), { now: NOW })).toEqual([]);
  });
});

describe('localToUtc', () => {
  it.each([
    ['2026-11-15T18:30', 'America/Chicago', '2026-11-16T00:30:00Z'],
    ['2026-10-12T10:00', 'America/Chicago', '2026-10-12T15:00:00Z'],
    ['2026-03-08T12:00', 'America/Chicago', '2026-03-08T17:00:00Z'],
    ['2026-03-08T01:30', 'America/Chicago', '2026-03-08T07:30:00Z'],
    ['2026-07-01T09:00', 'Australia/Sydney', '2026-06-30T23:00:00Z'],
  ])('%s in %s is %s', (local, tz, utc) => {
    expect(localToUtc(local, tz)).toBe(utc);
  });
});

describe('createBody', () => {
  const template = plan().template;

  it('sends the start as UTC start_date_v2 with the create field names and nothing the client never sends', () => {
    const body = createBody(planEvent({ local_start: '2026-11-15T18:30', details: 'Bring a deck' }), template, 'v2');

    expect(body).toEqual({
      name: "Ettin's TCG Practice Tournament",
      activity_group_id: 'ag-guid',
      organizer_id: 'organizer-guid',
      product: 'tcg',
      category: 'tcg_std',
      series_guid: null,
      address_id: 'address-guid',
      start_date_v2: '2026-11-16T00:30:00Z',
      contact_information: { email: 'league@example.com' },
      details: 'Bring a deck',
      activity_division_info: null,
    });
    for (const never of ['status', 'display_id', 'divisionless', 'play_template']) expect(body).not.toHaveProperty(never);
  });

  it('sends the naive local start with on-site registration 30 minutes before it in naive mode', () => {
    const body = createBody(planEvent({ local_start: '2026-11-15T18:30' }), template, 'naive');

    expect(body).not.toHaveProperty('start_date_v2');
    expect(body).toMatchObject({
      start_date: '2026-11-15T18:30:00',
      on_site_registration_datetime_full: '2026-11-15T18:00:00',
      on_site_registration_duration: 30,
    });
  });
});

describe('confirmCode', () => {
  it('is the last 6 hex chars of the sha256 of the bytes, and changes with a one-byte edit', () => {
    const bytes = new TextEncoder().encode('{"events":[]}');
    expect(confirmCode(bytes)).toBe(createHash('sha256').update(bytes).digest('hex').slice(-6));
    expect(confirmCode(new TextEncoder().encode('{"events":[ ]}'))).not.toBe(confirmCode(bytes));
  });
});

function tournament(over: Partial<TournamentDetail> = {}): TournamentDetail {
  return {
    guid: 'aaaaaaaa-0000-4000-8000-000000004745',
    display_id: '26-09-004745',
    product: 'tcg',
    application_state: 'sanctioned',
    activity_state: 'pending',
    start_date_v2: '2026-09-01T23:30:00Z',
    details: 'Standard format',
    organizer: { player_id: '7654321', guid: 'organizer-guid' },
    ...over,
  };
}

describe('cancelRefusal', () => {
  const ledger = { created: [{ guid: 'ledger-guid' }] };

  it('allows a sanctioned, pending tournament 42 days after its start', () => {
    expect(cancelRefusal(tournament(), ledger, NOW)).toBeNull();
  });

  it.each([
    ['complete', { application_state: 'complete', activity_state: 'completed' }, /application_state/],
    ['uploaded', { activity_state: 'completed' }, /activity_state/],
    ['91 days after its start', { start_date_v2: '2026-07-14T15:00:00Z' }, /90 days/],
    ['the run’s own tournament', { guid: 'ledger-guid' }, /ledger/],
  ])('refuses a tournament that is %s, naming why', (_label, over, reason) => {
    expect(cancelRefusal(tournament(over), ledger, NOW)).toMatch(reason);
  });

  it('reads status when application_state is absent', () => {
    expect(cancelRefusal(tournament({ application_state: undefined, status: 'cancelled' }), ledger, NOW)).toMatch(/cancelled/);
  });
});

describe('tdfMismatch', () => {
  const header = { tournamentId: '26-09-004745', organizerId: '7654321', gametype: 'TRADING_CARD_GAME' };

  it('passes a file that matches a sanctioned, pending tournament with no players', () => {
    expect(tdfMismatch(header, tournament(), 0, 'TRADING_CARD_GAME')).toBeNull();
  });

  it.each([
    ['another tournament id', { ...header, tournamentId: '26-09-004746' }, tournament(), 0, /tournament id/],
    ['another organizer', { ...header, organizerId: '1111111' }, tournament(), 0, /organizer/],
    ['another gametype', { ...header, gametype: 'VIDEO_GAME' }, tournament(), 0, /gametype/],
    ['a tournament with a player record', header, tournament(), 1, /player record/],
    ['a tournament awaiting approval', header, tournament({ application_state: 'approval-pending' }), 0, /approval-pending/],
    ['an upload already in progress', header, tournament({ activity_state: 'upload_in_progress' }), 0, /upload_in_progress/],
  ])('refuses %s', (_label, h, t, players, reason) => {
    expect(tdfMismatch(h, t, players, 'TRADING_CARD_GAME')).toMatch(reason);
  });
});

describe('restoreActions', () => {
  it('needs nothing when details and the start instant match the snapshot', () => {
    expect(restoreActions(tournament(), tournament({ start_date_v2: '2026-09-01T23:30:00.000Z' }))).toBeNull();
  });

  it('puts back whichever of details and start differ', () => {
    expect(restoreActions(tournament(), tournament({ details: 'Standard format .' }))).toEqual({ details: 'Standard format' });
    expect(restoreActions(tournament(), tournament({ start_date_v2: '2026-09-02T00:30:00Z' }))).toEqual({ start_date_v2: '2026-09-01T23:30:00Z' });
  });

  it('treats a missing details as empty, so null and "" are the same', () => {
    expect(restoreActions(tournament({ details: null }), tournament({ details: '' }))).toBeNull();
  });
});

describe('knownOriginalsFrom', () => {
  it('collects display ids, the organizer, the league and the venue from recorded bodies, plus the extras', () => {
    const calls = [
      { path: '/services/core/activities', request: null, response: { results: [{ display_id: '26-10-021965', activity_group: { guid: 'ag-guid' } }] } },
      { path: '/services/core/tournament', request: { activity_group_id: 'ag-guid', address_id: 'venue-guid', organizer_id: 'org-guid' }, response: { guid: 'x' } },
      { path: '/services/core/tournament/x', request: null, response: { organizer: { player_id: '0012345', guid: 'org-guid' }, details: 'see 26-09-004745' } },
    ];
    expect(knownOriginalsFrom(calls, ['sub-hex']).sort()).toEqual(['0012345', '26-09-004745', '26-10-021965', 'ag-guid', 'org-guid', 'sub-hex', 'venue-guid'].sort());
  });
});

describe('maskIds', () => {
  it('shows GUIDs, dashless ids and display ids by their last two characters only', () => {
    expect(maskIds('GET /services/core/users/93763009eecc499080dd46172f420fee/x/df02d0b2-a68e-974f-ab86-878ca8f574e9?t=26-10-021965 → 200')).toBe(
      'GET /services/core/users/…ee/x/…e9?t=…65 → 200',
    );
  });
});

describe('buildTemplate', () => {
  const input = {
    leagueGuid: 'ag-guid',
    now: NOW,
    products: { results: ['tcg', 'vg', 'pgo'], product_categories: { tcg: [{ slug: 'tcg_exp' }, { slug: 'tcg_std' }], vg: ['vg_mod'], pgo: ['pgo_std'] } },
    series: [{ guid: 'lc-guid', name: 'League Challenge', product: 'tcg', category_slugs: ['tcg_std'], schedule: { US: { start_date: '2026-10-01', end_date: '2026-10-31' } } }],
    addressBook: {
      results: [
        { guid: 'home-guid', country: 'US', timezone: 'America/Chicago', source: 'activity_group' },
        { guid: 'other-guid', country: 'US', timezone: 'America/New_York', source: 'user' },
      ],
    },
    detail: tournament({ contact_information: { email: 'league@example.com', phone: '' } }),
  };

  it('pre-fills the league, organizer, home venue, contact and one custom TCG event 24 h back, leaving the name empty', () => {
    const p = buildTemplate(input);

    expect(p.template).toEqual({
      activity_group_id: 'ag-guid',
      organizer_id: 'organizer-guid',
      address_id: 'home-guid',
      timezone: 'America/Chicago',
      contact_information: { email: 'league@example.com', phone: '' },
    });
    expect(p.events).toEqual([{ name: '', product: 'tcg', category: 'tcg_std', series_guid: null, local_start: '2026-10-12T10:00' }]);
    expect(p.categories).toEqual({ tcg: ['tcg_exp', 'tcg_std'], vg: ['vg_mod'], pgo: ['pgo_std'] });
    expect(p.series).toEqual([{ guid: 'lc-guid', product: 'tcg', category_slugs: ['tcg_std'], window: { start_date: '2026-10-01', end_date: '2026-10-31' } }]);
  });

  it('falls back to the first address-book entry and the first TCG category, and leaves a missing contact empty', () => {
    const p = buildTemplate({
      ...input,
      products: { results: ['tcg'], product_categories: { tcg: ['tcg_exp'] } },
      addressBook: [{ guid: 'first-guid', timezone: 'America/Chicago' }],
      detail: tournament(),
    });
    expect(p.template.address_id).toBe('first-guid');
    expect(p.template.contact_information).toEqual({});
    expect(p.events[0]?.category).toBe('tcg_exp');
  });
});
