import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestServer, client, setupCodeFrom, startServer } from './harness';

const OWNER = { username: 'organizer', password: 'correct horse' };
const WED = '2026-10-14';
const NEXT_WED = '2026-10-21';

function tdf(players: { userid: string; first?: string; last?: string }[], name = 'Wed League Cup'): string {
  const rows = players
    .map(
      (p) =>
        `<player userid="${p.userid}"><firstname>${p.first ?? ''}</firstname><lastname>${p.last ?? ''}</lastname><birthdate>01/02/2012</birthdate></player>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<tournament type="2" gametype="TRADING_CARD_GAME" mode="LEAGUECHALLENGE">
  <data><name>${name}</name><id>26-10-000123</id><organizer popid="7654321" name="Pat Organizer"/><startdate>10/14/2026</startdate></data>
  <players>${rows}</players>
</tournament>`;
}

describe('TDF import API', () => {
  let server: TestServer;
  let browser: ReturnType<typeof client>;

  beforeAll(async () => {
    server = await startServer();
    browser = client(server.url);
    const res = await browser.request('/api/auth/setup', {
      method: 'POST',
      json: { setupCode: setupCodeFrom(server.logs()), ...OWNER },
    });
    expect(res.status).toBe(200);
  });
  afterAll(() => server.dispose());

  const api = (path: string, init: RequestInit & { json?: unknown } = {}) => browser.request(`/api${path}`, init);
  const upload = (date: string, content: string, filename = 'cup.tdf') =>
    api(`/sessions/${date}/tdf`, { method: 'POST', json: { filename, content } });
  const commit = (date: string, uploadId: unknown) => api(`/sessions/${date}/tdf/${uploadId}/commit`, { method: 'POST', json: {} });

  describe('auth', () => {
    it.each([
      ['POST', `/api/sessions/${WED}/tdf`],
      ['POST', `/api/sessions/${WED}/tdf/1/commit`],
      ['POST', '/api/sessions/not-a-date/tdf'],
    ])('%s %s is 401 without a session, before any validation', async (method, path) => {
      const res = await client(server.url).request(path, { method, json: { filename: 'x.tdf', content: tdf([{ userid: '1' }]) } });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /sessions/{date}/tdf (preview)', () => {
    it('previews the players without importing them', async () => {
      await api('/regulars', { method: 'POST', json: { playerId: '900', name: 'Regular Rae' } });

      const res = await upload(
        WED,
        tdf([
          { userid: '0011', first: 'New', last: 'Nia' },
          { userid: '900', first: 'Regular', last: 'Rae' },
          { userid: 'oops', first: 'Bad', last: 'Row' },
        ]),
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        uploadId: expect.any(Number),
        filename: 'cup.tdf',
        tournament: { name: 'Wed League Cup', date: '2026-10-14' },
        alreadyImported: false,
        counts: { new: 1, known: 0, regulars: 1, listed: 0, invalid: 1, duplicates: 0 },
        players: [
          { playerId: '0011', name: 'New Nia', status: 'new' },
          { playerId: '900', name: 'Regular Rae', status: 'regular' },
        ],
        invalid: [{ name: 'Bad Row', reason: expect.any(String) }],
      });
      expect((await (await api(`/sessions/${WED}`)).json()).players).toEqual([]);
    });

    it('never echoes birthdates or the organizer', async () => {
      const text = await (await upload(WED, tdf([{ userid: '1', first: 'A' }]))).text();
      expect(text).not.toMatch(/2012|birth|7654321|Pat Organizer/);
    });

    it.each([
      ['no body fields', {}],
      ['an empty file', { filename: 'cup.tdf', content: '' }],
      ['no filename', { content: tdf([{ userid: '1' }]) }],
      ['a numeric content', { filename: 'cup.tdf', content: 5 }],
      ['a filename over 255 characters', { filename: `${'x'.repeat(252)}.tdf`, content: tdf([{ userid: '1' }]) }],
    ])('400 for %s', async (_label, json) => {
      expect((await api(`/sessions/${WED}/tdf`, { method: 'POST', json })).status).toBe(400);
    });

    it('400 for a date that is not a calendar date', async () => {
      expect((await upload('2026-02-30', tdf([{ userid: '1' }]))).status).toBe(400);
    });

    it('415 for a multipart upload (the CSRF guard: only JSON bodies)', async () => {
      const form = new FormData();
      form.append('file', new Blob([tdf([{ userid: '1' }])]), 'cup.tdf');
      const res = await api(`/sessions/${WED}/tdf`, { method: 'POST', body: form });
      expect(res.status).toBe(415);
    });

    it('422 with a reason for a file that is not a tournament', async () => {
      const res = await upload(WED, 'name,player_id\nAsh,1');
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ message: expect.stringMatching(/not a tournament file/i), data: { code: 'not_tdf' } });
    });

    it('422 for an XXE payload, without reading the file it names', async () => {
      const xxe = `<?xml version="1.0"?><!DOCTYPE t [<!ENTITY x SYSTEM "file:///etc/passwd">]><tournament><players><player userid="1"><firstname>&x;</firstname></player></players></tournament>`;
      const res = await upload(WED, xxe);
      expect(res.status).toBe(422);
      expect(await res.text()).not.toMatch(/root:/);
    });

    it('422 for a tournament with no players', async () => {
      const res = await upload(WED, tdf([]));
      expect(res.status).toBe(422);
      expect((await res.json()).data).toEqual({ code: 'no_players' });
    });

    it('413 for a body far over the 2 MB limit, refused before it is parsed', async () => {
      const res = await upload(WED, tdf([{ userid: '1' }]) + `<!--${'x'.repeat(5 * 1024 * 1024)}-->`);
      expect(res.status).toBe(413);
    });

    it('413 for a file just over 2 MB', async () => {
      const res = await upload(WED, tdf([{ userid: '1' }]) + `<!--${'x'.repeat(2 * 1024 * 1024)}-->`);
      expect(res.status).toBe(413);
    });
  });

  describe('POST /sessions/{date}/tdf/{uploadId}/commit', () => {
    it('imports the players: session lists the non-regulars and shows the import', async () => {
      const preview = await (await upload(NEXT_WED, tdf([{ userid: '0042', first: 'Ash', last: 'K' }, { userid: '900' }], 'Cup B'), 'b.tdf')).json();

      const res = await commit(NEXT_WED, preview.uploadId);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ added: 1, alreadyListed: 0, regulars: 1, alreadyImported: false });
      const session = await (await api(`/sessions/${NEXT_WED}`)).json();
      expect(session.players).toEqual([{ playerId: '0042', displayName: 'Ash K', source: 'tdf' }]);
      expect(session.imports).toEqual([
        { uploadId: preview.uploadId, filename: 'b.tdf', tournamentName: 'Cup B', playerCount: 2, importedAt: expect.any(String) },
      ]);
      const players = (await (await api('/players?q=0042')).json()).players;
      expect(players).toEqual([expect.objectContaining({ playerId: '0042', displayName: 'Ash K' })]);
    });

    it('is 200 and changes nothing when committed again', async () => {
      const { uploadId } = await (await upload(NEXT_WED, tdf([{ userid: '7' }]), 'c.tdf')).json();
      await commit(NEXT_WED, uploadId);

      const res = await commit(NEXT_WED, uploadId);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ added: 0, alreadyListed: 0, regulars: 0, alreadyImported: true });
    });

    it('re-uploading a committed file previews as already imported', async () => {
      const content = tdf([{ userid: '8' }]);
      const { uploadId } = await (await upload(NEXT_WED, content)).json();
      await commit(NEXT_WED, uploadId);

      const again = await (await upload(NEXT_WED, content)).json();
      expect(again).toMatchObject({ uploadId, alreadyImported: true });
    });

    it('409 tdf_file_deleted when the organizer deleted the file before committing, importing nothing', async () => {
      const { uploadId } = await (await upload(NEXT_WED, tdf([{ userid: '0055', first: 'Gone', last: 'File' }], 'Deleted Cup'), 'gone.tdf')).json();
      const { files } = await (await api('/tdf-files')).json();
      const file = files.find((f: { filename: string }) => f.filename === 'gone.tdf');
      expect((await api(`/tdf-files/${file.id}`, { method: 'DELETE' })).status).toBe(200);

      const res = await commit(NEXT_WED, uploadId);

      expect(res.status).toBe(409);
      expect((await res.json()).data).toEqual({ code: 'tdf_file_deleted' });
      expect((await (await api('/players?q=0055')).json()).players).toEqual([]);
    });

    it('404 for an unknown upload', async () => {
      expect((await commit(WED, 999999)).status).toBe(404);
    });

    it('404 for an upload previewed for another date', async () => {
      const { uploadId } = await (await upload(WED, tdf([{ userid: '9' }]))).json();
      expect((await commit(NEXT_WED, uploadId)).status).toBe(404);
    });

    it.each([['abc'], ['0'], ['-1'], ['1.5']])('400 for upload id %j', async (uploadId) => {
      expect((await commit(WED, uploadId)).status).toBe(400);
    });
  });
});
