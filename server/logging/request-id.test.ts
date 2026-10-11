import { describe, expect, it } from 'vitest';
import { acceptRequestId } from './request-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('acceptRequestId', () => {
  it('generates a UUID when the client sent none', () => {
    expect(acceptRequestId(undefined)).toMatch(UUID);
    expect(acceptRequestId(undefined)).not.toBe(acceptRequestId(undefined));
  });

  it.each(['abc-123.x:y_z', 'a', 'A'.repeat(64)])('honours a well-formed incoming id (%s)', (id) => {
    expect(acceptRequestId(id)).toBe(id);
  });

  it.each([
    ['empty', ''],
    ['65 characters', 'A'.repeat(65)],
    ['a space', 'abc 123'],
    ['a newline (log injection)', 'abc\n[2026-10-10 00:00:00.000] INFO: [setup] fake'],
    ['unicode', 'résumé'],
    ['two comma-joined headers', 'a1, b2'],
  ])('replaces an id with %s by a fresh UUID', (_, id) => {
    expect(acceptRequestId(id)).toMatch(UUID);
  });

  it('replaces repeated header values by a fresh UUID', () => {
    expect(acceptRequestId(['a1', 'b2'])).toMatch(UUID);
  });
});
