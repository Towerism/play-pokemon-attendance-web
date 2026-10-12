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

interface Grant {
  access_token: string;
  refresh_token: string;
}

async function tokenCall(form: Record<string, string>): Promise<{ status: number; body: Grant & { error?: string } }> {
  const res = await fetch(`${fake.url}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: 'op-tools-app', ...form }),
  });
  return { status: res.status, body: (await res.json()) as Grant & { error?: string } };
}

const exchange = (code: string) => tokenCall({ grant_type: 'authorization_code', code, code_verifier: 'v' });
const refresh = (refreshToken: string) => tokenCall({ grant_type: 'refresh_token', refresh_token: refreshToken });
const subOf = (accessToken: string) => (JSON.parse(Buffer.from(accessToken.split('.')[1]!, 'base64url').toString()) as { sub: string }).sub;

async function groups(accessToken: string) {
  const res = await fetch(`${fake.url}/services/core/users/${subOf(accessToken)}/activity_groups/`, { headers: { authorization: `Bearer ${accessToken}` } });
  return (await res.json()) as { results: { guid: string; group_type: string; owner?: { player_id: string } }[] };
}

describe('fake accounts (one per professor)', () => {
  it('serves the default account a personal group owned by its player id', async () => {
    const { results } = await groups(token);
    expect(results.find((g) => g.group_type === 'personal')?.owner?.player_id).toBe(fake.accounts[0]!.playerId);
    expect(results.filter((g) => g.group_type === 'league').map((g) => g.guid)).toEqual(['group-1']);
  });

  it("issues a second account's tokens for its own code, with its own sub, player id and leagues", async () => {
    const brock = fake.addAccount({ playerId: '0000222', name: 'Brock Harrison', leagues: [{ guid: 'group-2', display_id: 'L7', display_name: 'Gym', canSubmit: true }] });
    const { body } = await exchange(brock.code);
    expect(subOf(body.access_token)).toBe(brock.sub);
    const { results } = await groups(body.access_token);
    expect(results.find((g) => g.group_type === 'personal')?.owner?.player_id).toBe('0000222');
    expect(results.filter((g) => g.group_type === 'league').map((g) => g.guid)).toEqual(['group-2']);
  });

  it("keeps refresh chains apart: rotating one account's token leaves the other's valid", async () => {
    const brock = fake.addAccount({ playerId: '222', name: 'Brock Harrison' });
    const a = (await exchange('c2')).body;
    const b = (await exchange(brock.code)).body;
    expect((await refresh(a.refresh_token)).status).toBe(200);
    expect((await refresh(b.refresh_token)).status).toBe(200);
  });

  it('revokes only that chain when a rotated refresh token is reused, as Hydra does', async () => {
    const brock = fake.addAccount({ playerId: '222', name: 'Brock Harrison' });
    const a = (await exchange('c2')).body;
    const b = (await exchange(brock.code)).body;
    const rotated = (await refresh(a.refresh_token)).body;

    const reuse = await refresh(a.refresh_token);
    expect(reuse).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
    expect((await refresh(rotated.refresh_token)).status).toBe(400);
    expect(fake.reuseRevocations).toEqual([fake.accounts[0]!.playerId]);
    expect((await refresh(b.refresh_token)).status).toBe(200);
  });

  it('records which account authorised each OP API request', async () => {
    const brock = fake.addAccount({ playerId: '222', name: 'Brock Harrison' });
    const b = (await exchange(brock.code)).body;
    await groups(b.access_token);
    await groups(token);
    const calls = fake.requests.filter((r) => r.path.endsWith('/activity_groups/'));
    expect(calls.map((r) => r.as)).toEqual(['222', fake.accounts[0]!.playerId]);
  });

  it("refuses a league's play sessions to an account that isn't staff there", async () => {
    const brock = fake.addAccount({ playerId: '222', name: 'Brock Harrison', leagues: [] });
    const b = (await exchange(brock.code)).body;
    const res = await fetch(`${fake.url}/services/core/activity_groups/group-1/play_sessions/?status=active`, { headers: { authorization: `Bearer ${b.access_token}` } });
    expect(res.status).toBe(403);
  });

  it('revokeChain(playerId) revokes just that account; with no argument, the default one', async () => {
    const brock = fake.addAccount({ playerId: '222', name: 'Brock Harrison' });
    const a = (await exchange('c2')).body;
    const b = (await exchange(brock.code)).body;
    fake.revokeChain('222');
    expect((await refresh(b.refresh_token)).status).toBe(400);
    expect((await refresh(a.refresh_token)).status).toBe(200);
    fake.revokeChain();
    expect(fake.liveRefreshToken()).toBeUndefined();
  });

  it('lists every token it issued, for secret sweeps', async () => {
    const brock = fake.addAccount({ playerId: '222', name: 'Brock Harrison' });
    const b = (await exchange(brock.code)).body;
    expect(fake.issuedTokens()).toEqual(expect.arrayContaining([token, b.access_token, b.refresh_token]));
  });
});
