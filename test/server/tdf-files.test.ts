import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BIRTHDATE, tomTdf } from '../../shared/tdf/__fixtures__/tom';
import { type TestServer, client, logRecords, startServer } from './harness';

const OWNER = { username: 'organizer', password: 'correct horse' };
const WED = '2026-10-14';
const PLAYERS = [
  { userid: '1234567', first: 'Ash', last: 'Ketchum' },
  { userid: '0007654', first: 'Misty', last: 'Waterflower' },
];
/** Anything only the file itself may carry. */
const PRIVATE = new RegExp(`${BIRTHDATE.replace(/\//g, '\\/')}|birthdate|Ketchum|Waterflower`);

type Browser = ReturnType<typeof client>;

async function setUp(server: TestServer): Promise<Browser> {
  const browser = client(server.url);
  const res = await browser.request('/api/auth/setup', { method: 'POST', json: { setupCode: await server.setupCode(), ...OWNER } });
  expect(res.status).toBe(200);
  return browser;
}

const api = (browser: Browser, path: string, init: RequestInit & { json?: unknown } = {}) => browser.request(`/api${path}`, init);

async function preview(browser: Browser, content: string, filename = 'cup.tdf', date = WED) {
  const res = await api(browser, `/sessions/${date}/tdf`, { method: 'POST', json: { filename, content } });
  expect(res.status).toBe(200);
  return (await res.json()) as { uploadId: number };
}

async function files(browser: Browser, query = '') {
  const res = await api(browser, `/tdf-files${query}`);
  expect(res.status).toBe(200);
  return (await res.json()).files as { id: number; filename: string; keptFor: string[] }[];
}

describe('TDF archive API', () => {
  let server: TestServer;
  let browser: Browser;

  beforeAll(async () => {
    server = await startServer({ env: { NUXT_LOG_FORMAT: 'json' } });
    browser = await setUp(server);
  });
  afterAll(() => server.dispose());

  describe('auth', () => {
    it.each([
      ['GET', '/api/tdf-files'],
      ['GET', '/api/tdf-files?date=nope'],
      ['GET', '/api/tdf-files/1/download'],
      ['GET', '/api/tdf-files/abc/download'],
      ['DELETE', '/api/tdf-files/1'],
      ['DELETE', '/api/tdf-files/abc'],
    ])('%s %s is 401 without a session, before any validation', async (method, path) => {
      expect((await client(server.url).request(path, { method })).status).toBe(401);
    });
  });

  describe('GET /tdf-files', () => {
    it('lists each dropped file with its metadata, kept once it is imported, and never its content', async () => {
      const content = tomTdf({ players: PLAYERS, name: 'List Cup', idElement: '<id>26-10-000111</id>', startdate: '10/07/2026' });
      const { uploadId } = await preview(browser, content, 'list.tdf', '2026-10-07');

      const [listed] = await files(browser, '?tournamentId=26-10-000111');
      expect(listed).toEqual({
        id: expect.any(Number),
        filename: 'list.tdf',
        tournamentName: 'List Cup',
        tournamentDate: '2026-10-07',
        tournamentId: '26-10-000111',
        byteSize: Buffer.byteLength(content),
        keptFor: [],
        createdBy: 'organizer',
        createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      });

      await api(browser, `/sessions/2026-10-07/tdf/${uploadId}/commit`, { method: 'POST', json: {} });
      expect((await files(browser, '?date=2026-10-07')).map((f) => f.keptFor)).toEqual([['attendance']]);
      expect(await (await api(browser, '/tdf-files')).text()).not.toMatch(PRIVATE);
    });

    it.each([['?date=2026-02-30'], ['?date=10/14/2026'], [`?tournamentId=${'x'.repeat(65)}`], ['?tournamentId=']])(
      '400 for the query %s',
      async (query) => {
        expect((await api(browser, `/tdf-files${query}`)).status).toBe(400);
      },
    );
  });

  describe('GET /tdf-files/{id}/download', () => {
    it('serves the exact file as a no-store attachment and logs one audit line without its content', async () => {
      const content = tomTdf({ players: PLAYERS, name: 'Download Cup', eol: '\r\n' });
      await preview(browser, content, 'download.tdf');
      const [file] = (await files(browser)).filter((f) => f.filename === 'download.tdf');

      const res = await api(browser, `/tdf-files/${file!.id}/download`);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8');
      expect(res.headers.get('content-disposition')).toBe(`attachment; filename="download.tdf"; filename*=UTF-8''download.tdf`);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(content, 'utf8'))).toBe(true);

      await server.waitForLog(new RegExp(`"msg":"TDF file ${file!.id} downloaded"`));
      const records = logRecords(server.logs());
      expect(records.filter((r) => r.fileId === file!.id && /download/i.test(String(r.msg)))).toEqual([
        expect.objectContaining({ fileId: file!.id, by: 'organizer' }),
      ]);
      expect(server.logs()).not.toMatch(PRIVATE);
    });

    it('keeps the header safe for a name with quotes, a line break and accents', async () => {
      await preview(browser, tomTdf({ name: 'Odd Name Cup' }), 'Café "Cup"\r\nX.tdf');
      const [file] = (await files(browser)).filter((f) => f.filename.startsWith('Café'));

      const disposition = (await api(browser, `/tdf-files/${file!.id}/download`)).headers.get('content-disposition')!;

      expect(disposition).toBe(`attachment; filename="Caf_ _Cup___X.tdf"; filename*=UTF-8''Caf%C3%A9%20%22Cup%22%0D%0AX.tdf`);
    });

    it('404 for an id that is not stored', async () => {
      expect((await api(browser, '/tdf-files/999999/download')).status).toBe(404);
    });

    it.each([['abc'], ['0'], ['-1'], ['1.5']])('400 for id %j', async (id) => {
      expect((await api(browser, `/tdf-files/${id}/download`)).status).toBe(400);
    });
  });

  describe('DELETE /tdf-files/{id}', () => {
    it('deletes the file at once, reports the import that used it, and the import stays on the session', async () => {
      const date = '2026-10-21';
      const { uploadId } = await preview(browser, tomTdf({ players: PLAYERS, name: 'Delete Cup' }), 'delete.tdf', date);
      await api(browser, `/sessions/${date}/tdf/${uploadId}/commit`, { method: 'POST', json: {} });
      const [file] = (await files(browser)).filter((f) => f.filename === 'delete.tdf');

      const res = await api(browser, `/tdf-files/${file!.id}`, { method: 'DELETE' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ deleted: true, referencedBy: [{ kind: 'attendance', id: uploadId }] });
      expect((await api(browser, `/tdf-files/${file!.id}/download`)).status).toBe(404);
      expect((await api(browser, `/tdf-files/${file!.id}`, { method: 'DELETE' })).status).toBe(404);
      expect((await (await api(browser, `/sessions/${date}`)).json()).imports).toEqual([expect.objectContaining({ uploadId })]);
    });

    it.each([['abc'], ['0'], ['-1'], ['1.5']])('400 for id %j', async (id) => {
      expect((await api(browser, `/tdf-files/${id}`, { method: 'DELETE' })).status).toBe(400);
    });
  });
});

describe('TDF archive after the key changes (app.db restored without its secrets)', () => {
  let server: TestServer;

  afterAll(() => server?.dispose());

  it("answers 409 tdf_key_mismatch for a file the new key can't open, and still lists and deletes it", async () => {
    const first = await startServer({ env: { NUXT_TDF_VAULT_KEY: randomBytes(32).toString('base64') } });
    const before = await setUp(first);
    const { uploadId } = await preview(before, tomTdf({ players: PLAYERS }));
    await first.stop();

    server = await startServer({ dataDir: first.dataDir, env: { NUXT_TDF_VAULT_KEY: randomBytes(32).toString('base64') } });
    const browser = client(server.url);
    expect((await browser.request('/api/auth/login', { method: 'POST', json: OWNER })).status).toBe(200);
    const [file] = await files(browser);

    const download = await api(browser, `/tdf-files/${file!.id}/download`);
    expect(download.status).toBe(409);
    expect((await download.json()).data).toEqual({ code: 'tdf_key_mismatch' });
    expect(server.logs()).not.toMatch(PRIVATE);

    const commit = await api(browser, `/sessions/${WED}/tdf/${uploadId}/commit`, { method: 'POST', json: {} });
    expect(commit.status).toBe(409);
    expect((await commit.json()).data).toEqual({ code: 'tdf_key_mismatch' });

    expect((await api(browser, `/tdf-files/${file!.id}`, { method: 'DELETE' })).status).toBe(200);
  });
});
