/**
 * Spike S8 part 2 (#85), live: the tournament lifecycle and TDF calls M9 writes
 * through, recorded through the API with the organizer's go-ahead. Decisions
 * (2026-10-13): one TCG custom event 24 h back is created, edited and restored,
 * then gets a phony TDF; the 2026-09-01 event that never happened is cancelled.
 * Every decision is in `lib/s8.ts` / `lib/s8-flows.ts`; this file is I/O.
 *
 *   pnpm spike:s8-live reads                                         read-only; writes .secrets/s8-plan.template.json
 *   pnpm spike:s8-live create --plan <file> [--date-format naive]    dry run: prints what it sends and the code
 *   pnpm spike:s8-live create --plan <file> --confirm <code>         WRITES one POST core/tournament
 *   pnpm spike:s8-live edit --tournament <guid> --confirm <code>     WRITES details and start, then restores them
 *   pnpm spike:s8-live cancel --tournament <display_id> --confirm <code>
 *   pnpm spike:s8-live tdf-validate --tournament <display_id> --file <x.tdf> --confirm <code>   sends the file to Pokémon support
 *   pnpm spike:s8-live tdf-confirm --tournament <display_id> --confirm <code>
 *   pnpm spike:s8-live tdf-watch --tournament <display_id>
 *   pnpm spike:s8 spikes/.secrets/raw/s8-*.json                     sanitise into fixtures
 *
 * Codes: create = last 6 hex of the plan file's sha256; the others = last 6 of the tournament guid.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { OP_API_BASE } from '../server/modules/pokemon/adapters/play-tools/constants';
import { fail, heading, run, sleep } from './lib/cli';
import type { ApiCall } from './lib/har';
import { op } from './lib/op';
import { type DateFormat, type Plan, type TournamentDetail, buildTemplate, knownOriginalsFrom, maskIds } from './lib/s8';
import { type Deps, type S8Ledger, type Upstream, runCancel, runCreate, runEdit, runTdfConfirm, runTdfValidate, runTdfWatch } from './lib/s8-flows';
import { RAW_DIR, SECRETS_DIR, readSecretJson, writeSecretJson } from './lib/secrets';
import { summarizeTdf } from './lib/tdf-summary';
import { claimsOf, getAccessToken } from './lib/tokens';

const LEDGER = join(SECRETS_DIR, 's8-ledger.json');
const ORIGINALS = join(SECRETS_DIR, 's8-originals.json');
const OBSERVED = join(SECRETS_DIR, 's8-observed.json');
const TEMPLATE = join(SECRETS_DIR, 's8-plan.template.json');

/** What `reads` learned that later steps need: the gametype spelling per product. */
interface Observed {
  gametypes: Record<string, string>;
}
/** Until `reads` has seen real files; GO is known (S8 part 1). */
const DEFAULT_GAMETYPES: Record<string, string> = { tcg: 'TRADING_CARD_GAME', vg: 'VIDEO_GAME', pgo: 'GO' };

const recorded: ApiCall[] = [];
let step = 'reads';

function save(): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeSecretJson(join(RAW_DIR, `s8-${step}.${stamp}.json`), recorded);
  const before = readSecretJson<string[]>(ORIGINALS) ?? [];
  writeSecretJson(ORIGINALS, knownOriginalsFrom(recorded, before));
}

const upstream: Upstream = {
  async call(method, path, opts = {}) {
    const query = Object.fromEntries(Object.entries(opts.query ?? {}).map(([k, v]) => [k, String(v)]));
    const res = await op(method as 'GET', path, { query, body: opts.body, quiet: true });
    const url = new URL(path, OP_API_BASE);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    recorded.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), status: res.status, request: opts.body ?? null, response: res.body });
    console.log(`  ${maskIds(`${method} ${url.pathname}${url.search}`)} → ${res.status}`);
    return { status: res.status, body: res.body };
  },
};

const deps: Deps = {
  up: upstream,
  clock: { now: () => Date.now(), sleep: (ms) => sleep(ms).then(() => undefined) },
  ledger: {
    load: () => readSecretJson<S8Ledger>(LEDGER) ?? { created: [], uploads: [] },
    save: (l) => writeSecretJson(LEDGER, l),
  },
  log: (line) => console.log(maskIds(line)),
};

type Row = Record<string, unknown>;
const list = (body: unknown): Row[] => (Array.isArray(body) ? body : ((body as Row | null)?.results as Row[] | undefined) ?? []);
const nonNull = (o: unknown) => Object.values((o ?? {}) as Row).filter((v) => v !== null && v !== '').length;

async function get(path: string, query?: Record<string, string | number>): Promise<unknown> {
  const res = await upstream.call('GET', path, { query });
  return res.status >= 200 && res.status < 300 ? res.body : null;
}

async function reads(): Promise<void> {
  heading('S8 · reads (read-only)');
  const sub = claimsOf((await getAccessToken()).access_token)?.claims.sub;
  if (!sub) fail('The access token has no sub. Reconnect with pnpm spike:s1.');
  writeSecretJson(ORIGINALS, [...new Set([...(readSecretJson<string[]>(ORIGINALS) ?? []), sub])]);

  const rows = list(await get('core/activities', { type: 'tournament', role: 'organizer', sort_by: '-start_date', page_size: 40 }));
  if (!rows.length) fail('No tournaments listed for this account.');
  const now = Date.now();
  const startOf = (r: Row) => Date.parse(String(r.start_date_v2 ?? ''));
  const upcoming = rows.filter((r) => startOf(r) > now).slice(0, 4);

  let detail: TournamentDetail | null = null;
  for (const r of upcoming.length ? upcoming : rows.slice(0, 1)) {
    const d = (await get(`core/tournament/${String(r.guid)}`)) as TournamentDetail | null;
    const dRow = d as Row | null;
    const score = (x: Row | null) => (x ? nonNull(x) + (x.activity_division_info ? 100 : 0) : -1);
    if (score(dRow) > score(detail as Row | null)) detail = d;
  }
  if (!detail) fail('Could not read a tournament detail.');
  const d = detail as unknown as Row;
  // `activity_group` is a guid on some reads and an object on others.
  const group = d.activity_group ?? rows[0]?.activity_group;
  const league = String((group && typeof group === 'object' ? (group as Row).guid : group) ?? '');
  const country = String((d.organizer as Row | undefined)?.country ?? 'US');

  const products = await get('core/products', { country });
  const series = await get(`core/users/${sub}/activity_groups/${league}/series/`);
  const addressBook = await get(`core/v2/users/${detail.organizer?.guid ?? ''}/address_book`, { country, activity_group_id: league });
  await get('api/epoch/cycle');

  const observed: Observed = readSecretJson<Observed>(OBSERVED) ?? { gametypes: {} };
  for (const product of ['tcg', 'vg', 'pgo']) {
    const done = rows.find((r) => r.product === product && r.activity_state === 'completed');
    if (!done) continue;
    const uploads = list(await get(`triumph/tournament/${String(done.display_id)}/uploads/`));
    if (product === 'pgo') continue;
    const latest = uploads.find((u) => u.accepted !== false) ?? uploads[0];
    const id = latest && String(latest.guid ?? latest.upload_guid ?? latest.id ?? '');
    if (!id) continue;
    const file = await get(`triumph/tdf/${id}`);
    const text = typeof file === 'string' ? file : String((file as Row | null)?.payload ?? (file as Row | null)?.tdf ?? '');
    try {
      const s = summarizeTdf(text);
      observed.gametypes[product] = s.gametype;
      console.log(`  ${product} TDF: gametype="${s.gametype}" ${s.bytes} bytes, elements ${s.elements.join(', ')}`);
    } catch (err) {
      console.log(`  ${product} TDF download: ${(err as Error).message}; body keys: ${Object.keys((file ?? {}) as Row).join(', ') || typeof file}`);
    }
  }
  writeSecretJson(OBSERVED, observed);

  const plan = buildTemplate({ leagueGuid: league, now: new Date(), products, series, addressBook, detail });
  writeSecretJson(TEMPLATE, plan);
  console.log(`\nPlan template: ${TEMPLATE}`);
  console.log(`  event: ${JSON.stringify(plan.events[0])}`);
  console.log(`  venue timezone ${plan.template.timezone || '(missing)'}; contact ${plan.template.contact_information.email ? 'email' : ''} ${plan.template.contact_information.phone ? 'phone' : ''}`);
  console.log(`  series: ${plan.series.map((s) => `${s.product} ${JSON.stringify(s.window)}`).join('; ') || 'none'}`);
}

function code(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

async function create(planFile: string, fmt: DateFormat, confirm?: string): Promise<void> {
  const bytes = readFileSync(planFile);
  const plan = JSON.parse(bytes.toString('utf8')) as Plan;
  heading(`S8 · create (${confirm ? 'WRITES' : 'dry run'})`);
  const r = await runCreate(deps, { plan, planBytes: bytes, fmt, confirm });
  if (r.outcome === 'dry-run') {
    const shown = r.bodies.map((b) => ({ ...b, contact_information: Object.keys(b.contact_information).filter((k) => b.contact_information[k as 'email']) }));
    console.log(maskIds(JSON.stringify(shown, null, 2)));
    console.log(`\nTo send it: pnpm spike:s8-live create --plan ${planFile}${fmt === 'naive' ? ' --date-format naive' : ''} --confirm ${r.code}`);
  } else if (r.outcome === 'refused') {
    for (const p of r.problems ?? []) console.log(`  event ${p.index} ${p.field}: ${p.message}`);
    process.exitCode = 1;
  } else console.log(`\n${maskIds(JSON.stringify(r))}`);
}

run(async () => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { plan: { type: 'string' }, 'date-format': { type: 'string' }, confirm: { type: 'string' }, tournament: { type: 'string' }, file: { type: 'string' } },
  });
  step = positionals[0] ?? '';
  const t = values.tournament ?? '';
  const confirm = code(values.confirm);
  try {
    switch (step) {
      case 'reads':
        return await reads();
      case 'create': {
        const fmt = (values['date-format'] ?? 'v2') as DateFormat;
        if (!values.plan || !['v2', 'naive'].includes(fmt)) fail('Usage: create --plan <file> [--date-format v2|naive] [--confirm <code>]');
        return await create(values.plan, fmt, confirm);
      }
      case 'edit': {
        heading('S8 · edit and restore (WRITES)');
        const r = await runEdit(deps, { guid: t, confirm });
        if (r.outcome !== 'done' || !r.restored) process.exitCode = 1;
        return;
      }
      case 'cancel': {
        heading('S8 · cancel (WRITES; an organizer cannot undo a cancel)');
        if ((await runCancel(deps, { displayId: t, confirm })).outcome !== 'done') process.exitCode = 1;
        return;
      }
      case 'tdf-validate': {
        heading('S8 · TDF validate (WRITES; the file goes to Pokémon support)');
        if (!values.file) fail('Usage: tdf-validate --tournament <display_id> --file <x.tdf> --confirm <code>');
        const ledger = deps.ledger.load();
        const own = ledger.created.find((c) => c.display_id === t);
        const product = own?.planned.product ?? 'tcg';
        const expectedGametype = readSecretJson<Observed>(OBSERVED)?.gametypes[product] ?? DEFAULT_GAMETYPES[product]!;
        if (!confirm && own) {
          console.log(`  Build the TDF with: tournament id ${t}, your player id as organizer, gametype="${expectedGametype}",`);
          console.log(`  start date ${own.planned.local_start.slice(0, 10)}, and its players and standings.`);
        }
        const r = await runTdfValidate(deps, { displayId: t, file: readFileSync(values.file), confirm, expectedGametype });
        if (r.outcome !== 'done' || r.errors?.length) process.exitCode = 1;
        return;
      }
      case 'tdf-confirm': {
        heading('S8 · TDF confirm (WRITES)');
        if ((await runTdfConfirm(deps, { displayId: t, confirm })).outcome !== 'done') process.exitCode = 1;
        return;
      }
      case 'tdf-watch': {
        heading('S8 · TDF watch (read-only, every 30 s, up to 90 min)');
        const r = await runTdfWatch(deps, { displayId: t });
        console.log(`\n${JSON.stringify({ outcome: r.outcome, finalState: r.finalState, secondsIn: r.secondsIn })}`);
        if (r.outcome !== 'done') process.exitCode = 1;
        return;
      }
      default:
        fail('Usage: pnpm spike:s8-live reads | create | edit | cancel | tdf-validate | tdf-confirm | tdf-watch (see the header)');
    }
  } finally {
    if (recorded.length) {
      save();
      console.log(`\nRecorded ${recorded.length} call(s) under ${RAW_DIR}. Fixtures: pnpm spike:s8 ${RAW_DIR}/s8-*.json`);
    }
  }
});
