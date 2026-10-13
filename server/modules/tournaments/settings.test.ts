import { describe, expect, it } from 'vitest';
import { fillNameTokens, resolveSettings, type TemplateSettings } from './settings';

const TEMPLATE: TemplateSettings = {
  name: 'League Challenge {month} {year}',
  category: 'tcg_std',
  venue: { id: 'venue-shop', label: 'Card Shop', timeZone: 'America/Chicago', country: 'US' },
  startTime: '18:00',
  registration: { kind: 'on_site', opensBeforeMin: 60, closesAfterMin: 15, admission: null },
  contactEmail: 'league@example.com',
  contactPhone: null,
  details: 'Bring a deck.',
  eventWebsite: null,
};
const HALL = { id: 'venue-hall', label: 'Town Hall', timeZone: 'America/Chicago', country: 'US' };

describe('settings at creation: template, then schedule overrides, then the row', () => {
  const scheduleOverrides = [
    { effectiveFrom: '2026-11-01', fields: { venue: HALL } },
    { effectiveFrom: '2026-12-01', fields: { details: 'Doors at 5.' } },
  ];

  it('layers every override in effect on the scaffold date, the row last', () => {
    const settings = resolveSettings(TEMPLATE, scheduleOverrides, { name: 'Holiday Challenge' }, { occurrenceDate: '2026-12-15', localDate: '2026-12-15' });
    expect(settings).toEqual({ ...TEMPLATE, venue: HALL, details: 'Doors at 5.', name: 'Holiday Challenge' });
  });

  it('leaves out overrides that start after the scaffold date', () => {
    const settings = resolveSettings(TEMPLATE, scheduleOverrides, {}, { occurrenceDate: '2026-10-20', localDate: '2026-10-20' });
    expect(settings.venue).toEqual(TEMPLATE.venue);
    expect(settings.details).toBe('Bring a deck.');
  });

  it('applies an override from its first day, and a later one over an earlier one for the same field', () => {
    const settings = resolveSettings(
      TEMPLATE,
      [
        { effectiveFrom: '2026-11-03', fields: { details: 'Later.' } },
        { effectiveFrom: '2026-11-01', fields: { details: 'Earlier.' } },
      ],
      {},
      { occurrenceDate: '2026-11-03', localDate: '2026-11-04' },
    );
    expect(settings.details).toBe('Later.');
  });

  it('takes a start time from a schedule override, and never a date from any', () => {
    const settings = resolveSettings(
      TEMPLATE,
      [{ effectiveFrom: '2026-11-01', fields: { startTime: '13:00', localDate: '2026-12-25' } as never }],
      { localDate: '2026-11-20' },
      { occurrenceDate: '2026-11-10', localDate: '2026-11-10' },
    );
    expect(settings.startTime).toBe('13:00');
    expect(settings).not.toHaveProperty('localDate');
  });

  it('fills the name tokens from the local date, not the scaffold date', () => {
    expect(resolveSettings(TEMPLATE, [], {}, { occurrenceDate: '2026-10-31', localDate: '2026-11-01' }).name).toBe('League Challenge November 2026');
  });
});

describe('name tokens', () => {
  it('fills {month}, {year} and {date}, every time each appears', () => {
    expect(fillNameTokens('{month} Cup {date} ({year}, {year})', '2027-01-05')).toBe('January Cup 2027-01-05 (2027, 2027)');
  });

  it('leaves unknown braces as typed', () => {
    expect(fillNameTokens('Cup {day} {}', '2027-01-05')).toBe('Cup {day} {}');
  });
});
