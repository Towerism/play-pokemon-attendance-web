import { describe, expect, it } from 'vitest';
import { fillNameTokens, readOverrides, readRegistration, resolveSettings, type SettingsOverrides, type TemplateSettings } from './settings';

const TEMPLATE: TemplateSettings = {
  name: 'League Challenge {month} {year}',
  category: 'tcg_std',
  venue: { id: 'venue-shop', label: 'Card Shop', timeZone: 'America/Chicago', country: 'US' },
  startTime: '18:00',
  registration: { kind: 'on_site', opensBeforeMin: 60, closesAfterMin: 15, admissionCents: null },
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
      { localDate: '2026-11-20' } as SettingsOverrides,
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

describe('stored registration from before admission was an amount', () => {
  const window = { kind: 'on_site', opensBeforeMin: 60, closesAfterMin: 15 } as const;

  it('reads admission text that is an amount as cents', () => {
    expect(readRegistration({ ...window, admission: '$12' })).toEqual({ registration: { ...window, admissionCents: 1200 }, legacyAdmission: null });
    expect(readRegistration({ ...window, admission: 'FREE' }).registration).toEqual({ ...window, admissionCents: 0 });
    expect(readRegistration({ ...window, admission: null })).toEqual({ registration: { ...window, admissionCents: null }, legacyAdmission: null });
  });

  it('reads other text as no admission and hands the text back so the form can show it', () => {
    expect(readRegistration({ ...window, admission: 'Bring a snack' })).toEqual({
      registration: { ...window, admissionCents: null },
      legacyAdmission: 'Bring a snack',
    });
  });

  it('reads the current shape and third-party registration unchanged', () => {
    expect(readRegistration({ ...window, admissionCents: 750 })).toEqual({ registration: { ...window, admissionCents: 750 }, legacyAdmission: null });
    const thirdParty = { kind: 'third_party', url: 'https://tickets.example.com' } as const;
    expect(readRegistration(thirdParty)).toEqual({ registration: thirdParty, legacyAdmission: null });
  });

  it('converts a registration held in overrides, and leaves overrides without one as they are', () => {
    expect(readOverrides({ details: 'Doors at 5.', registration: { ...window, admission: '$10' } })).toEqual({
      details: 'Doors at 5.',
      registration: { ...window, admissionCents: 1000 },
    });
    expect(readOverrides({ details: 'Doors at 5.' })).toEqual({ details: 'Doors at 5.' });
  });

  it('lets a row override stored with old text win over the template once converted', () => {
    const row = readOverrides({ registration: { ...window, admission: '$10' } });
    const settings = resolveSettings({ ...TEMPLATE, registration: { ...window, admissionCents: 500 } }, [], row, { occurrenceDate: '2026-12-15', localDate: '2026-12-15' });
    expect(settings.registration).toEqual({ ...window, admissionCents: 1000 });
  });
});
