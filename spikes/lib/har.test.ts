import { describe, expect, it } from 'vitest';
import { type ApiCall, apiCalls, loadCalls, sanitizeCalls } from './har';

const API = 'https://api.play.pokemon.com/services';
const TOURNAMENT = 'b5e0c6c2-1111-4aaa-8bbb-0123456789ab';
const RECORD = 'c7f1d8e3-2222-4ccc-8ddd-0123456789ab';

function entry(method: string, url: string, opts: { status?: number; req?: unknown; res?: unknown; text?: string; mime?: string; encoding?: string } = {}) {
  return {
    request: {
      method,
      url,
      headers: [
        { name: 'Authorization', value: 'Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.sig' },
        { name: 'Cookie', value: 'incap_ses=secret' },
      ],
      cookies: [{ name: 'incap_ses', value: 'secret' }],
      ...(opts.req !== undefined ? { postData: { mimeType: 'application/json', text: JSON.stringify(opts.req) } } : {}),
    },
    response: {
      status: opts.status ?? 200,
      headers: [{ name: 'Set-Cookie', value: 'visid=secret' }],
      content: {
        mimeType: opts.mime ?? 'application/json',
        text: opts.text ?? (opts.res === undefined ? '' : JSON.stringify(opts.res)),
        ...(opts.encoding ? { encoding: opts.encoding } : {}),
      },
    },
  };
}

const har = (...entries: unknown[]) => ({ log: { entries } });

describe('apiCalls', () => {
  it('keeps only calls to the API host, as method, path, query, status and parsed bodies', () => {
    const calls = apiCalls(
      har(
        entry('GET', 'https://play-tools.pokemon.com/assets/index.js', { mime: 'text/javascript', text: 'x' }),
        entry('POST', `${API}/core/tournaments/${TOURNAMENT}/records/`, {
          status: 201,
          req: [{ participant: { player_id: '1234567' }, role: 'judge' }],
          res: [{ guid: RECORD }],
        }),
        entry('OPTIONS', `${API}/core/tournaments/${TOURNAMENT}/records/`, { status: 204 }),
      ),
    );

    expect(calls).toEqual([
      {
        method: 'POST',
        path: `/services/core/tournaments/${TOURNAMENT}/records/`,
        query: {},
        status: 201,
        request: [{ participant: { player_id: '1234567' }, role: 'judge' }],
        response: [{ guid: RECORD }],
      },
    ]);
  });

  it('never carries headers or cookies over', () => {
    const json = JSON.stringify(apiCalls(har(entry('GET', `${API}/core/tournament/123/`, { res: {} }))));
    expect(json).not.toMatch(/Bearer|eyJ|incap|visid|secret|[Cc]ookie|[Aa]uthorization/);
  });

  it('parses query strings and base64 bodies, and summarises non-JSON bodies instead of keeping them', () => {
    const [list, html] = apiCalls(
      har(
        entry('GET', `${API}/core/tournaments/${TOURNAMENT}/records/?page=2&page_size=10`, {
          encoding: 'base64',
          text: Buffer.from(JSON.stringify({ count: 0, results: [] })).toString('base64'),
        }),
        entry('DELETE', `${API}/core/tournaments/${TOURNAMENT}/records/${RECORD}/`, {
          status: 500,
          mime: 'text/html',
          text: '<html>Server Error</html>',
        }),
      ),
    );

    expect(list?.query).toEqual({ page: '2', page_size: '10' });
    expect(list?.response).toEqual({ count: 0, results: [] });
    expect(html?.response).toEqual({ nonJson: 'text/html', bytes: 25 });
    expect(html?.request).toBeNull();
  });

  it('rejects input that is not a HAR', () => {
    expect(() => apiCalls({ entries: [] })).toThrow(/not a HAR/);
  });
});

describe('sanitizeCalls', () => {
  const raw = apiCalls(
    har(
      entry('GET', `${API}/core/player_ids/1234567/?search=Ash%20Ketchum&name=Ash`, {
        res: { player_id: '1234567', first_name: 'Ash', email: 'ash@example.com' },
      }),
      entry('POST', `${API}/core/tournaments/${TOURNAMENT}/records/`, {
        status: 201,
        req: [{ participant: { player_id: '1234567' }, role: 'judge' }],
        res: [{ guid: RECORD }],
      }),
      entry('DELETE', `${API}/core/tournaments/${TOURNAMENT}/records/${RECORD}/`, { status: 204 }),
    ),
  );

  it('pseudonymises ids consistently across bodies and URL paths, keeping roles and structure', () => {
    const { calls, leaks } = sanitizeCalls(raw);
    const [lookup, add, remove] = calls;

    expect(leaks).toEqual([]);
    expect(lookup?.path).toBe('/services/core/player_ids/9999991/');
    expect(lookup?.response).toEqual({ player_id: '9999991', first_name: '<redacted>', email: '<redacted>' });
    expect(add?.request).toEqual([{ participant: { player_id: '9999991' }, role: 'judge' }]);
    const fakeRecord = (add?.response as { guid: string }[])[0]?.guid;
    expect(fakeRecord).toMatch(/^00000000-0000-4000-8000-/);
    expect(remove?.path).toBe(`/services/core/tournaments/${add?.path.split('/')[4]}/records/${fakeRecord}/`);
  });

  it('pseudonymises tournament display ids consistently and redacts event free text and websites', () => {
    const { calls, leaks } = sanitizeCalls(
      apiCalls(
        har(
          entry('GET', `${API}/core/tournament/${TOURNAMENT}`, {
            res: { display_id: '26-10-010393', details: 'Ask for Brock at the desk', event_website: 'https://store.example', status: 'complete' },
          }),
          entry('GET', `${API}/core/activities`, { res: { results: [{ display_id: '26-10-010393' }, { display_id: '24-11-004912' }] } }),
        ),
      ),
    );
    expect(leaks).toEqual([]);
    expect(calls[0]?.response).toEqual({ display_id: '26-10-900001', details: '<redacted>', event_website: '<redacted>', status: 'complete' });
    expect(calls[1]?.response).toEqual({ results: [{ display_id: '26-10-900001' }, { display_id: '24-11-900002' }] });
  });

  it('redacts free-text search and name parameters', () => {
    const { calls } = sanitizeCalls(raw);
    expect(calls[0]?.query).toEqual({ search: '<redacted>', name: '<redacted>' });
    expect(JSON.stringify(calls)).not.toMatch(/Ash|Ketchum|1234567|example\.com/);
  });

  it('replaces a known player id wherever it appears, e.g. inside an error message, even before its key is seen', () => {
    const { calls, leaks } = sanitizeCalls(
      apiCalls(
        har(
          entry('POST', `${API}/core/tournaments/${TOURNAMENT}/records/`, { status: 400, res: { errors: { detail: 'Player 7654321 is already staff' } } }),
          entry('GET', `${API}/core/player_ids/`, { res: { player_id: 7654321 } }),
        ),
      ),
    );
    expect(leaks).toEqual([]);
    expect(calls[0]?.response).toEqual({ errors: { detail: 'Player 9999991 is already staff' } });
  });
});

describe('sanitizeCalls: TDFs and known originals', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<tournament gametype="TRADING_CARD_GAME"><data><id>26-10-000123</id><organizer popid="7654321" name="Pat Organizer" /></data>
<players><player userid="1234567"><firstname>Ash</firstname><birthdate>01/02/2012</birthdate></player></players></tournament>
`;
  const base64 = Buffer.from(xml).toString('base64');
  const summary = { tdf: '<redacted>', bytes: Buffer.byteLength(xml), gametype: 'TRADING_CARD_GAME', elements: ['tournament', 'data', 'players'] };
  const call = (over: Partial<ApiCall>): ApiCall => ({ method: 'GET', path: '/services/x', query: {}, status: 200, request: null, response: null, ...over });

  it('replaces a TDF in an upload body, and in a download as base64 or raw XML, with its summary', () => {
    const { calls, leaks } = sanitizeCalls([
      call({ method: 'POST', path: '/services/triumph/tdf/', request: { kind: 'tdf', tournament_id: '26-10-000123', payload: base64 }, response: { upload_guid: TOURNAMENT, errors: [] } }),
      call({ path: `/services/triumph/tdf/${RECORD}`, response: { payload: base64 } }),
      call({ path: `/services/triumph/tdf/${RECORD}`, response: xml }),
    ]);
    const json = JSON.stringify(calls);

    expect(leaks).toEqual([]);
    expect(calls[0]?.request).toEqual({ kind: 'tdf', tournament_id: '26-10-900001', payload: summary });
    expect(calls[1]?.response).toEqual({ payload: summary });
    expect(calls[2]?.response).toEqual(summary);
    expect(json).not.toContain(base64.slice(0, 40));
    expect(json).not.toMatch(/<tournament|<player|Ash|01\/02\/2012|1234567|7654321/);
  });

  it('pseudonymises player ids inside upload error messages, which no key names', () => {
    const { calls, leaks } = sanitizeCalls([
      call({ response: [{ errors: [{ type: 'ORGANIZER_ID_MISMATCH', message: '4589085 !== 4942060' }], upload_timestamp: 1789926304744 }] }),
    ]);
    expect(leaks).toEqual([]);
    expect(calls[0]?.response).toEqual([{ errors: [{ type: 'ORGANIZER_ID_MISMATCH', message: '9999991 !== 9999992' }], upload_timestamp: 1789926304744 }]);
  });

  it('redacts any other long base64 string, which could be an encoded file', () => {
    const blob = Buffer.from('PK\u0003\u0004'.padEnd(400, 'x')).toString('base64');
    const { calls } = sanitizeCalls([call({ response: { file: blob } })]);
    expect(calls[0]?.response).toEqual({ file: { base64: '<redacted>', bytes: 400 } });
  });

  it('refuses when a known original survives under a key no rule redacts, counting it without echoing it', () => {
    const { leaks } = sanitizeCalls([call({ response: { note: 'moved from Ettin Games' } })], { knownOriginals: ['Ettin Games', 'never-seen'] });
    expect(leaks).toEqual(['Ettin Games']);
  });

  it('accepts the run when no known original survives', () => {
    const { leaks } = sanitizeCalls([call({ response: { display_id: '26-10-021965' } })], { knownOriginals: ['26-10-021965'] });
    expect(leaks).toEqual([]);
  });
});

describe('loadCalls', () => {
  it('reads a HAR or a list of calls recorded by the live probe', () => {
    const call = { method: 'GET', path: '/services/core/tournament/x', query: {}, status: 200, request: null, response: {} };
    expect(loadCalls([call])).toEqual([call]);
    expect(loadCalls(har(entry('GET', `${API}/core/tournament/x`, { res: {} })))).toEqual([call]);
  });

  it('rejects a list whose items are not calls', () => {
    expect(() => loadCalls([{ url: 'x' }])).toThrow(/not a recorded call/);
  });
});
