/**
 * Spike S7 (read-only): where does the connected professor's name live?
 *
 *   pnpm spike:s7
 *
 * Prints the shape of `https://me.pokemon.com/me` and of the id_token claims,
 * plus whether the personal activity group carries `owner.player_id`. Values
 * are never printed: name-like fields show only their first letter and length,
 * so the output is safe to paste into the issue. Raw responses go to .secrets/raw/.
 */
import { join } from 'node:path';
import { PTC_OAUTH } from '../server/modules/pokemon/adapters/ptc-oauth/constants';
import { decodeJwtPayload } from '../server/modules/pokemon/adapters/ptc-oauth/wire';
import { opPaths } from '../server/modules/pokemon/adapters/play-tools/constants';
import { ActivityGroupsPage } from '../server/modules/pokemon/adapters/play-tools/wire';
import { heading, run } from './lib/cli';
import { op } from './lib/op';
import { profileReport } from './lib/profile';
import { RAW_DIR, writeSecretJson } from './lib/secrets';
import { claimsOf, getAccessToken } from './lib/tokens';

run(async () => {
  const t = await getAccessToken();

  heading('S7 · id_token claims');
  if (t.id_token) for (const line of profileReport('id_token', decodeJwtPayload(t.id_token))) console.log(`  ${line}`);
  else console.log('  (no id_token stored; reconnect with `pnpm spike:s1` to get one)');

  heading(`S7 · GET ${PTC_OAUTH.userinfoEndpoint}`);
  const me = await fetch(PTC_OAUTH.userinfoEndpoint, {
    headers: { accept: 'application/json', authorization: `Bearer ${t.access_token}` },
  });
  const meBody: unknown = await me.json().catch(() => null);
  writeSecretJson(join(RAW_DIR, 'misc.userinfo.json'), { status: me.status, body: meBody });
  console.log(`  status ${me.status}`);
  for (const line of profileReport('me', meBody)) console.log(`  ${line}`);

  heading('S7 · personal activity group owner');
  const sub = claimsOf(t.access_token)?.claims.sub;
  if (!sub) throw new Error('access token has no sub');
  await new Promise((r) => setTimeout(r, 1500));
  const res = await op('GET', opPaths.userActivityGroups(sub), { query: { page: 1, page_size: 25 } });
  const parsed = ActivityGroupsPage.safeParse(res.body);
  const personal = parsed.success ? parsed.data.items.find((g) => g.group_type === 'personal') : undefined;
  const ownerId = personal?.owner?.player_id;
  console.log(`  personal group: ${personal ? 'found' : 'missing'} · owner.player_id: ${ownerId ? `present (${String(ownerId).length} digits)` : 'missing'}`);

  console.log('\nPaste everything above into issue #66. It contains no names, ids or tokens.');
});
