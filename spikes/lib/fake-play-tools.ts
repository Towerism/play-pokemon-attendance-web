/**
 * Test helper for the S8 flows: a stateful, in-memory play-tools that applies
 * creates, PATCHes and uploads, plus a fake clock. Tests assert on its final
 * state, not just on call counts. Failures are injected per call.
 */
import type { Clock, Upstream, UpstreamResponse } from './s8-flows';
import type { TournamentDetail } from './s8';

export interface SentCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  at: number;
}

type Injected = UpstreamResponse | 'throw';
type Matcher = (c: SentCall) => boolean;

export class FakeClock implements Clock {
  constructor(public t = Date.parse('2026-10-13T15:40:00Z')) {}
  now = () => this.t;
  sleep = async (ms: number) => {
    this.t += Math.max(0, ms);
  };
}

const PAGE = 2;

export class FakePlayTools implements Upstream {
  readonly sent: SentCall[] = [];
  readonly tournaments = new Map<string, TournamentDetail & Record<string, unknown>>();
  readonly playerRecords = new Map<string, number>();
  readonly uploads = new Map<string, { display_id: string; confirmed?: boolean }>();
  /** Answers a partial create-field PATCH with 400 (the server wants the full body). */
  refusePartialPatch = false;
  /** Tournament id form `triumph/{u}/confirm/` accepts. */
  confirmAccepts: 'guid' | 'display_id' = 'guid';
  /** `activity_state` the tournament reports on each successive read after confirm. */
  afterConfirm: string[] = [];
  private readonly failures: { match: Matcher; response: Injected }[] = [];
  private next = 1;

  constructor(private readonly clock: FakeClock) {}

  add(t: Partial<TournamentDetail> & Record<string, unknown> = {}): TournamentDetail & Record<string, unknown> {
    const n = this.next++;
    const row = {
      guid: `t-guid-${n}`,
      display_id: `26-10-00000${n}`,
      name: `Tournament ${n}`,
      product: 'tcg',
      application_state: 'sanctioned',
      activity_state: 'pending',
      start_date_v2: '2026-10-12T15:00:00Z',
      details: 'Bring a deck',
      organizer: { player_id: '7654321', guid: 'organizer-guid' },
      ...t,
    };
    this.tournaments.set(row.guid, row);
    return row;
  }

  /** The next call matching `match` gets `response` instead of being handled. */
  failOnce(match: Matcher, response: Injected): void {
    this.failures.push({ match, response });
  }

  count(method: string, path: RegExp): number {
    return this.sent.filter((c) => c.method === method && path.test(c.path)).length;
  }

  async call(method: string, path: string, opts: { query?: Record<string, string | number>; body?: unknown } = {}): Promise<UpstreamResponse> {
    const c: SentCall = {
      method,
      path,
      query: Object.fromEntries(Object.entries(opts.query ?? {}).map(([k, v]) => [k, String(v)])),
      body: opts.body,
      at: this.clock.now(),
    };
    this.sent.push(c);
    const i = this.failures.findIndex((f) => f.match(c));
    if (i >= 0) {
      const [f] = this.failures.splice(i, 1);
      if (f!.response === 'throw') throw new Error('network timeout');
      return f!.response;
    }
    return this.handle(c);
  }

  private handle(c: SentCall): UpstreamResponse {
    const body = (c.body ?? {}) as Record<string, unknown>;
    let m: RegExpMatchArray | null;
    if (c.method === 'POST' && c.path === 'core/tournament') {
      const t = this.add({ ...body, application_state: 'sanctioned', activity_state: 'pending' } as Partial<TournamentDetail>);
      return { status: 201, body: { guid: t.guid } };
    }
    if ((m = c.path.match(/^core\/tournament\/([^/]+)\/?$/))) {
      const t = this.tournaments.get(m[1]!);
      if (!t) return { status: 404, body: { code: 'op.generic.not_found' } };
      if (c.method === 'GET') {
        if (this.uploads.size && [...this.uploads.values()].some((u) => u.confirmed && u.display_id === t.display_id) && this.afterConfirm.length) {
          t.activity_state = this.afterConfirm.length > 1 ? this.afterConfirm.shift()! : this.afterConfirm[0]!;
        }
        return { status: 200, body: structuredClone(t) };
      }
      if (c.method === 'PATCH') {
        const keys = Object.keys(body);
        if (this.refusePartialPatch && !keys.includes('application_state') && !keys.includes('name')) {
          return { status: 400, body: { code: 'op.generic.bad_request', errors: { body: { name: [{ code: 'required' }] } } } };
        }
        Object.assign(t, body);
        return { status: 200, body: structuredClone(t) };
      }
    }
    if (c.method === 'GET' && c.path === 'core/activities') {
      const all = [...this.tournaments.values()].sort((a, b) => Date.parse(b.start_date_v2!) - Date.parse(a.start_date_v2!));
      const page = Number(c.query.page ?? 1);
      const results = all.slice((page - 1) * PAGE, page * PAGE).map((t) => ({ ...t, status: t.application_state }));
      return { status: 200, body: { count: all.length, next: page * PAGE < all.length ? `core/activities?page=${page + 1}` : null, results } };
    }
    if (c.method === 'GET' && (m = c.path.match(/^core\/tournaments\/([^/]+)\/records$/))) {
      const n = this.playerRecords.get(m[1]!) ?? 0;
      return { status: 200, body: { count: n, next: null, results: [] } };
    }
    if (c.method === 'POST' && c.path === 'triumph/tdf/') {
      const u = `upload-${this.uploads.size + 1}`;
      this.uploads.set(u, { display_id: String(body.tournament_id) });
      return { status: 200, body: { upload_guid: u, errors: [] } };
    }
    if (c.method === 'PUT' && (m = c.path.match(/^triumph\/([^/]+)\/confirm\/$/))) {
      const u = this.uploads.get(m[1]!);
      const t = [...this.tournaments.values()].find((x) => x.display_id === u?.display_id);
      const accepted = this.confirmAccepts === 'guid' ? t?.guid : t?.display_id;
      if (!u || body.tournament_id !== accepted) return { status: 400, body: { code: 'op.generic.bad_request' } };
      u.confirmed = true;
      t!.activity_state = 'upload_in_progress';
      return { status: 200, body: {} };
    }
    if (c.method === 'GET' && /^triumph\/(tournament\/[^/]+\/uploads\/|tdf\/[^/]+)$/.test(c.path)) {
      return { status: 200, body: { results: [...this.uploads.keys()].map((g) => ({ guid: g })) } };
    }
    return { status: 404, body: { unhandled: `${c.method} ${c.path}` } };
  }
}
