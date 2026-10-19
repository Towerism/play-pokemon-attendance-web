import { describe, expect, it } from 'vitest';
import { AttendanceDayV1, CreateIntegrationTokenBody, IntegrationTokenIdParam, MessageResultBody, MessagesQuery, MessagesV1 } from './integrations';

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
    expect(CreateIntegrationTokenBody.parse(body)).toEqual({ label, scopes: ['integrations:read'] });
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

describe('the Discord channel wire (ADR-0015 §7)', () => {
  it('reads wait (0–25, default 0) and limit (1–50, default 20) from the query', () => {
    expect(MessagesQuery.parse({})).toEqual({ wait: 0, limit: 20 });
    expect(MessagesQuery.parse({ wait: '25', limit: '50' })).toEqual({ wait: 25, limit: 50 });
    expect(MessagesQuery.parse({ wait: '0', limit: '1' })).toEqual({ wait: 0, limit: 1 });
    for (const q of [{ wait: '-1' }, { wait: '26' }, { wait: '1.5' }, { wait: 'x' }, { limit: '0' }, { limit: '51' }]) {
      expect(MessagesQuery.safeParse(q).success, JSON.stringify(q)).toBe(false);
    }
  });

  it('takes a result of delivered, no_discord_user, dm_refused or failed, with a reason of at most 200 characters', () => {
    expect(MessageResultBody.parse({ status: 'failed', reason: 'x'.repeat(200) })).toEqual({ status: 'failed', reason: 'x'.repeat(200) });
    expect(MessageResultBody.parse({ status: 'delivered' })).toEqual({ status: 'delivered' });
    for (const b of [{}, { status: 'sent' }, { status: 'failed', reason: 'x'.repeat(201) }]) expect(MessageResultBody.safeParse(b).success).toBe(false);
  });

  it('pins the poll answer strictly, so a renamed field fails', () => {
    const message = { id: 1, playerId: '0012345', text: 'hi', link: { label: 'Accept the invite', url: 'https://x/invite#s' }, expiresAt: '2026-10-22T12:00:00.000Z' };
    expect(MessagesV1.parse({ messages: [message, { ...message, link: null }] }).messages).toHaveLength(2);
    expect(MessagesV1.safeParse({ messages: [{ ...message, topic: 'invite' }] }).success).toBe(false);
  });
});

describe('minting a token with scopes', () => {
  it('defaults to integrations:read and refuses an empty or unknown scope', () => {
    expect(CreateIntegrationTokenBody.parse({ label: 'Genie' })).toEqual({ label: 'Genie', scopes: ['integrations:read'] });
    expect(CreateIntegrationTokenBody.parse({ label: 'Genie', scopes: ['messages:deliver'] })).toEqual({ label: 'Genie', scopes: ['messages:deliver'] });
    expect(CreateIntegrationTokenBody.safeParse({ label: 'Genie', scopes: [] }).success).toBe(false);
    expect(CreateIntegrationTokenBody.safeParse({ label: 'Genie', scopes: ['admin'] }).success).toBe(false);
  });
});
