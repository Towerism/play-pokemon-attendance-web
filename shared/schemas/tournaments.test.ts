import { describe, expect, it } from 'vitest';
import {
  ApplyBody,
  CreateThroughBody,
  EditBody,
  EditTargetParam,
  CreateThroughQuery,
  CreateTournamentsBody,
  IdParam,
  OptionsQuery,
  PlannedBody,
  PlannedPatch,
  ScaffoldBody,
  ScaffoldPatch,
  ScheduleBody,
  SchedulePatch,
  SchedulePreviewBody,
  TemplateBody,
  TemplatePatch,
  UpcomingQuery,
} from './tournaments';

const ok = (schema: { safeParse(v: unknown): { success: boolean } }, v: unknown) => schema.safeParse(v).success;

const VALID_TEMPLATE = {
  name: 'League Challenge {month}',
  organizerPlayerId: '9999991',
  product: 'tcg',
  category: 'tcg_std',
  type: { kind: 'premier', seriesMatch: 'League Challenge' },
  venue: { id: '00000000-0000-4000-8000-000000000051', label: 'Card Shop', timeZone: 'America/Chicago', country: 'US' },
  startTime: '18:00',
  registration: { kind: 'on_site', opensBeforeMin: 60, closesAfterMin: 15, admission: null },
  contactEmail: 'league@example.com',
  contactPhone: null,
  details: null,
  eventWebsite: null,
};

describe('TemplateBody', () => {
  it('accepts a full template and trims the name', () => {
    expect(TemplateBody.parse({ ...VALID_TEMPLATE, name: '  Cup  ' }).name).toBe('Cup');
  });

  it('turns blank and missing optional text into null', () => {
    const { contactPhone: _p, details: _d, eventWebsite: _e, ...rest } = VALID_TEMPLATE;
    expect(TemplateBody.parse({ ...rest, details: '  ' })).toMatchObject({ contactPhone: null, details: null, eventWebsite: null });
  });

  it.each([
    ['an 80-character name', { name: 'x'.repeat(80) }, true],
    ['an 81-character name', { name: 'x'.repeat(81) }, false],
    ['an empty name', { name: '  ' }, false],
    ['25:00', { startTime: '25:00' }, false],
    ['9:00', { startTime: '9:00' }, false],
    ['23:59', { startTime: '23:59' }, true],
    ['an http website', { eventWebsite: 'http://example.com' }, false],
    ['an https website', { eventWebsite: 'https://example.com/cup' }, true],
    ['a 501-character website', { eventWebsite: `https://example.com/${'x'.repeat(481)}` }, false],
    ['no contact at all', { contactEmail: null, contactPhone: null }, false],
    ['a phone alone', { contactEmail: null, contactPhone: '555-0100' }, true],
    ['a bad email', { contactEmail: 'not-an-email' }, false],
    ['a lower-case country', { venue: { ...VALID_TEMPLATE.venue, country: 'us' } }, false],
    ['an unknown time zone', { venue: { ...VALID_TEMPLATE.venue, timeZone: 'Mars/Olympus' } }, false],
    ['a product play-tools lacks', { product: 'ptcgl' }, false],
    ['a format with a slash', { category: 'tcg/std' }, false],
    ['custom', { type: { kind: 'custom' } }, true],
    ['premier with no match', { type: { kind: 'premier', seriesMatch: ' ' } }, false],
    ['details of 2,000 characters', { details: 'x'.repeat(2000) }, true],
    ['details of 2,001 characters', { details: 'x'.repeat(2001) }, false],
    ['a third-party registration', { registration: { kind: 'third_party', url: 'https://tickets.example.com' } }, true],
    ['a third-party http registration', { registration: { kind: 'third_party', url: 'http://tickets.example.com' } }, false],
    ['registration opening 1,441 minutes before', { registration: { ...VALID_TEMPLATE.registration, opensBeforeMin: 1441 } }, false],
    ['an organizer id with letters', { organizerPlayerId: '99a' }, false],
  ])('%s → %s', (_, patch, valid) => {
    expect(ok(TemplateBody, { ...VALID_TEMPLATE, ...patch })).toBe(valid);
  });
});

describe('TemplatePatch', () => {
  it('takes any one field', () => {
    expect(TemplatePatch.parse({ details: 'Doors at 5.' })).toEqual({ details: 'Doors at 5.' });
  });

  it('refuses an empty patch and a cleared contact pair', () => {
    expect(ok(TemplatePatch, {})).toBe(false);
    expect(ok(TemplatePatch, { contactEmail: null, contactPhone: null })).toBe(false);
  });
});

describe('ScaffoldBody', () => {
  const slot = { templateId: 1, dayOffset: 0, startTime: null };

  it.each([
    ['one slot', { name: 'Saturday', slots: [slot] }, true],
    ['ten slots', { name: 'Many', slots: Array(10).fill(slot) }, true],
    ['eleven slots', { name: 'Too many', slots: Array(11).fill(slot) }, false],
    ['no slots', { name: 'Empty', slots: [] }, false],
    ['an offset of 6', { name: 'Weekend', slots: [{ ...slot, dayOffset: 6 }] }, true],
    ['an offset of 7', { name: 'Weekend', slots: [{ ...slot, dayOffset: 7 }] }, false],
    ['a slot start time', { name: 'Back to back', slots: [{ ...slot, startTime: '16:00' }] }, true],
    ['a template id of 0', { name: 'Bad', slots: [{ ...slot, templateId: 0 }] }, false],
  ])('%s → %s', (_, body, valid) => {
    expect(ok(ScaffoldBody, body)).toBe(valid);
  });

  it('patches the name or the slots, not nothing', () => {
    expect(ok(ScaffoldPatch, { name: 'New' })).toBe(true);
    expect(ok(ScaffoldPatch, {})).toBe(false);
  });
});

describe('ScheduleBody', () => {
  const valid = { scaffoldId: 1, rule: { kind: 'monthly', nth: 3, weekday: 2 }, startsOn: '2026-10-01', endsOn: null };

  it.each([
    ['no horizon', valid, true],
    ['a horizon of 26', { ...valid, horizonWeeks: 26 }, true],
    ['a horizon of 27', { ...valid, horizonWeeks: 27 }, false],
    ['a horizon of 0', { ...valid, horizonWeeks: 0 }, false],
    ['a last date before the first', { ...valid, endsOn: '2026-09-30' }, false],
    ['a last date on the first', { ...valid, endsOn: '2026-10-01' }, true],
    ['a rule the engine lacks', { ...valid, rule: { kind: 'yearly' } }, false],
    ['a non-date', { ...valid, startsOn: '2026-02-30' }, false],
  ])('%s → %s', (_, body, validity) => {
    expect(ok(ScheduleBody, body)).toBe(validity);
  });

  it('patches anything but the scaffold, checking the dates it is given', () => {
    expect(ok(SchedulePatch, { paused: true })).toBe(true);
    expect(ok(SchedulePatch, { scaffoldId: 2 })).toBe(false);
    expect(ok(SchedulePatch, { startsOn: '2026-10-02', endsOn: '2026-10-01' })).toBe(false);
    expect(ok(SchedulePatch, {})).toBe(false);
  });

  it('previews up to 26 dates, 10 by default', () => {
    expect(SchedulePreviewBody.parse({ rule: valid.rule, startsOn: valid.startsOn }).count).toBe(10);
    expect(ok(SchedulePreviewBody, { rule: valid.rule, startsOn: valid.startsOn, count: 27 })).toBe(false);
  });
});

describe('planned tournaments', () => {
  it('a one-off needs a template and a date', () => {
    expect(ok(PlannedBody, { templateId: 1, localDate: '2026-10-20' })).toBe(true);
    expect(ok(PlannedBody, { templateId: 1, localDate: '2026-10-20', startTime: '7pm' })).toBe(false);
    expect(ok(PlannedBody, { localDate: '2026-10-20' })).toBe(false);
  });

  it.each([
    [{ skipped: true }, true],
    [{ seriesId: 'custom' }, true],
    [{ seriesId: null }, true],
    [{ seriesId: '../x' }, false],
    [{ localDate: '2026-10-21', startTime: '13:00' }, true],
    [{}, false],
  ])('a patch %j → %s', (body, valid) => {
    expect(ok(PlannedPatch, body)).toBe(valid);
  });
});

describe('queries and params', () => {
  it('options default the country to US and need a professor', () => {
    expect(OptionsQuery.parse({ professor: '9999991' })).toEqual({ professor: '9999991', country: 'US' });
    expect(ok(OptionsQuery, { professor: '9999991', country: 'USA' })).toBe(false);
    expect(ok(OptionsQuery, {})).toBe(false);
  });

  it.each([
    [{}, true],
    [{ from: '2026-10-01', to: '2027-10-01' }, true],
    [{ from: '2026-10-01', to: '2027-10-02' }, false],
    [{ from: '2026-10-02', to: '2026-10-01' }, false],
    [{ from: 'today' }, false],
  ])('upcoming %j → %s', (query, valid) => {
    expect(ok(UpcomingQuery, query)).toBe(valid);
  });

  it.each([
    ['1', true],
    ['1234567890', true],
    ['0', false],
    ['abc', false],
    ['12345678901', false],
  ])('id %s → %s', (id, valid) => {
    expect(ok(IdParam, { id })).toBe(valid);
  });
});

describe('creating in play-tools (#92)', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

  it.each([
    [0, false],
    [1, true],
    [60, true],
    [61, false],
  ])('takes %i planned ids: %s', (n, valid) => {
    expect(CreateTournamentsBody.safeParse({ plannedIds: ids(n) }).success).toBe(valid);
  });

  it('defaults both confirmations to false, and takes only booleans', () => {
    expect(CreateTournamentsBody.parse({ plannedIds: [3] })).toEqual({ plannedIds: [3], acknowledgeShortNotice: false, retryUnknown: false });
    expect(CreateTournamentsBody.safeParse({ plannedIds: [3], retryUnknown: 'true' }).success).toBe(false);
    expect(CreateTournamentsBody.safeParse({ plannedIds: [3], acknowledgeShortNotice: 1 }).success).toBe(false);
  });

  it.each([[[1, 1]], [[1.5]], [['1']], [[0]]])('refuses planned ids %j', (plannedIds) => {
    expect(CreateTournamentsBody.safeParse({ plannedIds }).success).toBe(false);
  });

  it('refuses unknown fields', () => {
    expect(CreateTournamentsBody.safeParse({ plannedIds: [1], force: true }).success).toBe(false);
  });

  it('takes a calendar date to create through', () => {
    expect(CreateThroughQuery.parse({ date: '2026-12-31' })).toEqual({ date: '2026-12-31' });
    expect(CreateThroughQuery.safeParse({ date: '2026-02-30' }).success).toBe(false);
    expect(CreateThroughQuery.safeParse({}).success).toBe(false);
    expect(CreateThroughBody.parse({ date: '2026-12-31' })).toEqual({ date: '2026-12-31', acknowledgeShortNotice: false });
    expect(CreateThroughBody.safeParse({ date: '31/12/2026' }).success).toBe(false);
  });
});

describe('editing (#93)', () => {
  it('takes any editable field, and fills the defaults', () => {
    expect(EditBody.parse({ changes: { localDate: '2026-10-22', details: '' } })).toEqual({
      changes: { localDate: '2026-10-22', details: null },
      scope: 'this',
      withSiblings: false,
      updateTemplate: false,
    });
  });

  it.each([
    ['no changes', { changes: {} }],
    ['an unknown field', { changes: { organizerPlayerId: '1' } }],
    ['a field play-tools keeps read-only', { changes: { product: 'vg' } }],
    ['a bad date', { changes: { localDate: '2026-02-30' } }],
    ['a bad time', { changes: { startTime: '24:00' } }],
    ['an unknown scope', { changes: { name: 'X' }, scope: 'next' }],
    ['the date as a carried field', { changes: { name: 'X' }, fields: ['localDate'] }],
    ['a field outside the body', { changes: { name: 'X' }, force: true }],
  ])('refuses %s', (_what, body) => {
    expect(ok(EditBody, body)).toBe(false);
  });

  it('takes up to 200 excluded keys, planned or play-tools', () => {
    const keys = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 ? `p:${i + 1}` : `t:00000000-0000-4000-8000-${String(i).padStart(12, '0')}`));
    expect(ApplyBody.parse({ changes: { name: 'X' }, excluded: keys(200) }).excluded).toHaveLength(200);
    expect(ok(ApplyBody, { changes: { name: 'X' }, excluded: keys(201) })).toBe(false);
    expect(ok(ApplyBody, { changes: { name: 'X' }, excluded: ['x:1'] })).toBe(false);
    expect(ApplyBody.parse({ changes: { name: 'X' } })).toMatchObject({ excluded: [], acknowledgeShortNotice: false, clearShadowingOverrides: false });
  });

  it.each([
    ['42', { kind: 'planned', id: 42 }],
    ['00000000-0000-4000-8000-000000000001', { kind: 'tournament', id: '00000000-0000-4000-8000-000000000001' }],
  ])('reads %s as a planned id or a play-tools guid', (id, parsed) => {
    expect(EditTargetParam.parse({ id })).toEqual({ id: parsed });
  });

  it.each(['0', 'abc', '../x', ''])('refuses the id %j', (id) => {
    expect(ok(EditTargetParam, { id })).toBe(false);
  });
});
