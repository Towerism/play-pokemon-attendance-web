import { describe, expect, it } from 'vitest';
import { Sanitizer, findLeaks } from './sanitize';

const GROUP = 'df02d0b2-a68e-974f-ab86-878ca8f574e9';
const SESSION = 'a1b2c3d4-0000-4111-8222-123456789abc';

describe('Sanitizer', () => {
  const raw = {
    next: `https://api.play.pokemon.com/services/core/activity_groups/${GROUP}/play_sessions/?page=2`,
    results: [
      {
        id: SESSION,
        start_datetime: '2026-10-14T23:00:00Z',
        participant: { player_id: '0012345', first_name: 'Ash', last_name: 'Ketchum', birth_date: '2014-05-01' },
        contact: 'ash@example.com',
        token: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.sig',
      },
      { id: SESSION, participant: { player_id: 987654 } },
    ],
  };

  it('pseudonymises ids consistently and redacts personal fields, keeping structure and dates', () => {
    const s = new Sanitizer();
    const out = s.sanitize(raw) as typeof raw;
    const [first, second] = out.results;

    expect(out.next).toBe('https://api.play.pokemon.com/services/core/activity_groups/00000000-0000-4000-8000-000000000001/play_sessions/?page=2');
    expect(first?.id).toBe('00000000-0000-4000-8000-000000000002');
    expect(second?.id).toBe(first?.id);
    expect(first?.start_datetime).toBe('2026-10-14T23:00:00Z');
    expect(first?.participant).toEqual({
      player_id: '9999991',
      first_name: '<redacted>',
      last_name: '<redacted>',
      birth_date: '<redacted>',
    });
    expect(second?.participant.player_id).toBe(999992);
    expect(first?.contact).toBe('user@example.invalid');
    expect(first?.token).toBe('<jwt>');
  });

  it('leaves no originals behind', () => {
    const s = new Sanitizer();
    const json = JSON.stringify(s.sanitize(raw));
    expect(s.originals).toEqual(expect.arrayContaining([GROUP, SESSION.toLowerCase(), '0012345', '987654']));
    expect(findLeaks(json, s.originals)).toEqual([]);
    expect(json).not.toMatch(/Ash|Ketchum|2014-05-01/);
  });

  it('redacts whole personal subtrees and keeps nulls (nullable schema fields stay valid)', () => {
    const out = new Sanitizer().sanitize({
      address: { street: '1 Main St', city: 'Town' },
      participant: { display_first_name: 'Misty', display_last_name: null },
    });
    expect(out).toEqual({ address: '<redacted>', participant: { display_first_name: '<redacted>', display_last_name: null } });
  });

  it('pseudonymises dashless 32-hex ids (the user sub) like GUIDs, consistently with their dashed form', () => {
    const sub = '93763009eecc499080dd46172f420fee';
    const dashed = '93763009-eecc-4990-80dd-46172f420fee';
    const s = new Sanitizer();
    const out = s.sanitize({ path: `/services/core/users/${sub}/activity_groups/`, owner: dashed, sha: 'a'.repeat(64) }) as Record<string, string>;

    expect(out.path).toBe('/services/core/users/00000000000040008000000000000001/activity_groups/');
    expect(out.owner).toBe('00000000-0000-4000-8000-000000000001');
    expect(out.sha).toBe('a'.repeat(64));
    expect(findLeaks(JSON.stringify(out), s.originals)).toEqual([]);
    expect(findLeaks(`{"x":"${sub}"}`, s.originals)).toEqual([sub]);
    expect(findLeaks(`{"x":"${dashed}"}`, s.originals)).toEqual([dashed]);
  });

  it('findLeaks reports surviving originals', () => {
    expect(findLeaks(`{"x":"${GROUP.toUpperCase()}"}`, [GROUP])).toEqual([GROUP]);
  });
});
