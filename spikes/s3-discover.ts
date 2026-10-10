/**
 * Spikes S5 + S3 (read-only).
 *
 *   pnpm spike:s3 [--group <activityGroupId>] [--session <playSessionId>] [--user <opUserId>]
 *
 * S5: which id does `core/users/{id}/activity_groups/` want? Tries the access
 *     token `sub`, the id_token `sub`, then any id-like field from userinfo.
 * S3: records play_sessions for each status (2 pages, small page_size, to see
 *     pagination) and one session's attendance records.
 *
 * Only GET requests, spaced ≥ 1.5 s apart. Raw responses go to .secrets/raw/.
 */
import { parseArgs } from 'node:util';
import { PTC_OAUTH } from '../server/modules/pokemon/adapters/ptc-oauth/constants';
import { decodeJwtPayload } from '../server/modules/pokemon/adapters/ptc-oauth/wire';
import { opPaths } from '../server/modules/pokemon/adapters/play-tools/constants';
import {
  ActivityGroupsPage,
  PLAY_SESSION_START_GTE,
  PLAY_SESSION_START_LTE,
  PLAY_SESSION_STATUSES,
  PlaySessionsPage,
} from '../server/modules/pokemon/adapters/play-tools/wire';
import { heading, run } from './lib/cli';
import { describeShape, op } from './lib/op';
import { RAW_DIR, writeSecretJson } from './lib/secrets';
import { claimsOf, getAccessToken } from './lib/tokens';
import { join } from 'node:path';

/** Activity group hardcoded in the predecessor CLI; fallback when discovery fails. */
const CLI_GROUP_ID = 'df02d0b2-a68e-974f-ab86-878ca8f574e9';
const PAGE_SIZE = 5;

run(async () => {
  const { values: args } = parseArgs({
    options: { group: { type: 'string' }, session: { type: 'string' }, user: { type: 'string' } },
  });

  const groupId = args.group ?? (await s5DiscoverGroup(args.user)) ?? CLI_GROUP_ID;
  heading(`S3 · play sessions for group ${groupId}`);

  let sessionForRecords = args.session;
  for (const status of PLAY_SESSION_STATUSES) {
    for (const page of [1, 2]) {
      const res = await op('GET', opPaths.playSessions(groupId), {
        query: { status, page, page_size: PAGE_SIZE },
        recordAs: { kind: 'play-sessions-page', label: `${status}.p${page}` },
      });
      console.log(`    shape: ${describeShape(res.body)}`);
      if (res.status !== 200 || !hasNextPage(res.body)) break;
    }
  }

  // §4.4: can a date resolve to its session(s) with one server-side filtered query?
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 86_400_000);
  heading('S3 · date-filtered query (last 30 days, complete)');
  const filtered = await op('GET', opPaths.playSessions(groupId), {
    query: {
      status: 'complete',
      page: 1,
      page_size: 10,
      [PLAY_SESSION_START_GTE]: from.toISOString(),
      [PLAY_SESSION_START_LTE]: to.toISOString(),
    },
    recordAs: { kind: 'play-sessions-page', label: 'complete.last30d' },
  });
  console.log(`    shape: ${describeShape(filtered.body)}`);
  // Results are ascending by start_date, so the last one is the most recent completed session.
  const recent = PlaySessionsPage.safeParse(filtered.body);
  sessionForRecords ??= recent.success ? recent.data.items.at(-1)?.guid : undefined;

  if (!sessionForRecords) {
    console.log('\nNo completed session found; pass --session <id> to record attendance pages.');
    return;
  }
  heading(`S3 · attendance records for session ${sessionForRecords}`);
  for (const page of [1, 2]) {
    const res = await op('GET', opPaths.records(groupId, sessionForRecords), {
      query: { player: 'true', page, page_size: PAGE_SIZE },
      recordAs: { kind: 'attendance-page', label: `p${page}` },
    });
    console.log(`    shape: ${describeShape(res.body)}`);
    if (res.status !== 200 || !hasNextPage(res.body)) break;
  }
  console.log(`\nRaw responses in ${RAW_DIR}. Next: \`pnpm spike:fixtures\` to sanitize them into committed fixtures.`);
});

async function s5DiscoverGroup(explicitUser?: string): Promise<string | undefined> {
  heading('S5 · which user id lists activity groups?');
  const t = await getAccessToken();
  const candidates = new Map<string, string>();
  if (explicitUser) candidates.set('--user', explicitUser);
  const accessSub = claimsOf(t.access_token)?.claims.sub;
  if (accessSub) candidates.set('access_token.sub', accessSub);
  if (t.id_token) {
    const sub = (decodeJwtPayload(t.id_token) as { sub?: string }).sub;
    if (sub) candidates.set('id_token.sub', sub);
  }

  const userinfo = await fetch(PTC_OAUTH.userinfoEndpoint, {
    headers: { accept: 'application/json', authorization: `Bearer ${t.access_token}` },
  });
  const userinfoBody: unknown = await userinfo.json().catch(() => null);
  writeSecretJson(join(RAW_DIR, 'misc.userinfo.json'), { status: userinfo.status, body: userinfoBody });
  console.log(`  GET ${PTC_OAUTH.userinfoEndpoint} → ${userinfo.status} · ${describeShape(userinfoBody)}`);
  for (const [k, v] of Object.entries(userinfoBody && typeof userinfoBody === 'object' ? userinfoBody : {})) {
    if (/(^|_)(id|sub|guid|uuid)$/i.test(k) && (typeof v === 'string' || typeof v === 'number')) {
      candidates.set(`userinfo.${k}`, String(v));
    }
  }

  const tried = new Set<string>();
  for (const [source, id] of candidates) {
    if (tried.has(id)) continue;
    tried.add(id);
    console.log(`  trying ${source}`);
    const res = await op('GET', opPaths.userActivityGroups(id), {
      query: { page: 1, page_size: 25 },
      recordAs: { kind: 'activity-groups-page', label: source.replace(/[^\w.-]/g, '_') },
    });
    console.log(`    shape: ${describeShape(res.body)}`);
    const parsed = ActivityGroupsPage.safeParse(res.body);
    const items = parsed.success ? parsed.data.items : [];
    if (res.status === 200) {
      console.log(
        `\n  ✓ S5 answer: ${source} works · ${items.length} group(s): ${items.map((g) => `${g.guid} (${g.group_type}: ${g.display_name ?? g.display_id ?? '?'})`).join(', ')}`,
      );
      const leagues = items.filter((g) => g.group_type === 'league');
      return leagues.length === 1 ? leagues[0]!.guid : undefined;
    }
  }
  console.log(`\n  ✗ S5: no candidate worked. In play-tools devtools, find the users/{id}/activity_groups call and rerun with --user <id>.`);
  return undefined;
}

/** Pagination style is unknown until S3, so fetch page 2 on a `next` link OR a full page. */
function hasNextPage(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const b = body as { next?: unknown; results?: unknown[]; data?: unknown[] };
  return Boolean(b.next) || (b.results ?? b.data ?? []).length >= PAGE_SIZE;
}

