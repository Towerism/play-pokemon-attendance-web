import { describe, expect, it } from 'vitest';
import { AttendanceDayV1, CreateIntegrationTokenBody, IntegrationTokenIdParam } from './integrations';

const day = {
  date: '2026-10-14',
  timezone: 'America/Chicago',
  tournaments: [
    {
      id: 't-1',
      name: 'Olive Cup',
      displayId: null,
      startsAt: '2026-10-14T22:00:00.000Z',
      game: null,
      organizer: { playerId: '9999991', name: 'Olive Organizer' },
      staff: [{ playerId: '00456', name: 'Misty', role: 'headjudge' }],
    },
  ],
  professors: [
    { playerId: '9999991', name: 'Olive Organizer', status: 'read' },
    { playerId: '0000222', name: 'Professor 0000222', status: 'unread', reason: 'needs_reconnect' },
  ],
};

describe('AttendanceDayV1', () => {
  it('accepts the v1 contract', () => {
    expect(AttendanceDayV1.parse(day)).toEqual(day);
  });

  it.each([
    ['an extra top-level field', { ...day, extra: 1 }],
    ['an unknown game', { ...day, tournaments: [{ ...day.tournaments[0], game: 'pokken' }] }],
    ['an unknown staff role', { ...day, tournaments: [{ ...day.tournaments[0], staff: [{ playerId: '1', name: 'x', role: 'organizer' }] }] }],
    ['an unknown reason', { ...day, professors: [{ playerId: '1', name: 'x', status: 'unread', reason: 'gone' }] }],
    ['a start that is not UTC ISO', { ...day, tournaments: [{ ...day.tournaments[0], startsAt: '2026-10-14 17:00' }] }],
  ])('rejects %s, so any drift from the contract fails loudly', (_label, value) => {
    expect(AttendanceDayV1.safeParse(value).success).toBe(false);
  });
});

describe('CreateIntegrationTokenBody', () => {
  it.each([
    ['a label', { label: 'Tournament Genie' }, 'Tournament Genie'],
    ['a trimmed label', { label: '  Genie  ' }, 'Genie'],
    ['60 characters', { label: 'x'.repeat(60) }, 'x'.repeat(60)],
  ])('accepts %s', (_l, body, label) => {
    expect(CreateIntegrationTokenBody.parse(body)).toEqual({ label });
  });

  it.each([
    ['an empty body', {}],
    ['an empty label', { label: '' }],
    ['a blank label', { label: '   ' }],
    ['61 characters', { label: 'x'.repeat(61) }],
    ['a number', { label: 5 }],
    ['null', null],
  ])('rejects %s', (_l, body) => {
    expect(CreateIntegrationTokenBody.safeParse(body).success).toBe(false);
  });
});

describe('IntegrationTokenIdParam', () => {
  it('accepts a positive integer id', () => {
    expect(IntegrationTokenIdParam.parse({ id: '12' })).toEqual({ id: 12 });
  });
  it.each(['0', '-1', '1.5', 'abc', '1e3'])('rejects %j', (id) => {
    expect(IntegrationTokenIdParam.safeParse({ id }).success).toBe(false);
  });
});
