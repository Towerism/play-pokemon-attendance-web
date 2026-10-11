import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakePokemon, startFakePokemon } from '../server/fake-pokemon';

// The fake play-tools the server and E2E tests share. These pin the test-only
// knobs the E2E journeys steer, so a change to the fake can't silently break them.

const BULK = '/services/core/activity_groups/group-1/play_sessions/ps-1/records/_bulk/';

let fake: FakePokemon;
let token: string;

beforeEach(async () => {
  fake = await startFakePokemon();
  const res = await fetch(`${fake.url}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'op-tools-app', code: 'c', code_verifier: 'v' }),
  });
  token = ((await res.json()) as { access_token: string }).access_token;
});
afterEach(() => fake.close());

function bulk(playerIds: string[]) {
  return fetch(`${fake.url}${BULK}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(playerIds.map((id) => ({ participant: { player_id: id } }))),
  });
}

const stored = () => (fake.records.get('ps-1') ?? []).map((r) => r.participant.player_id);

describe('fake play-tools', () => {
  it('records the player ids each bulk call carried', async () => {
    await bulk(['111', '0222']);
    expect(fake.requests.filter((r) => r.path === BULK).map((r) => r.playerIds)).toEqual([['111', '0222']]);
  });

  it('dropOnce: the next bulk answers 201 for everyone but does not store the dropped ids', async () => {
    fake.dropOnce.add('222');
    const res = await bulk(['111', '222']);
    expect(res.status).toBe(201);
    expect(await res.json()).toHaveLength(2);
    expect(stored()).toEqual(['111']);
  });

  it('dropOnce is consumed by one bulk call, so a retry stores the player', async () => {
    fake.dropOnce.add('222');
    await bulk(['222']);
    expect(fake.dropOnce.size).toBe(0);
    await bulk(['222']);
    expect(stored()).toEqual(['222']);
  });

  it('stores everyone when nothing is dropped (the default the server tests rely on)', async () => {
    await bulk(['111', '222']);
    expect(stored()).toEqual(['111', '222']);
  });
});
