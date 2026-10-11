import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CreateLoggerOptions, createLogger, silentLogger } from './logger';

function memory(isTTY = false) {
  const lines: string[] = [];
  return {
    lines,
    text: () => lines.join(''),
    records: () => lines.join('').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>),
    destination: { write: (line: string) => void lines.push(line), isTTY },
  };
}

function json(opts: Partial<CreateLoggerOptions> = {}) {
  const out = memory();
  const log = createLogger({ scope: 'test', level: 'info', format: 'json', destination: out.destination, ...opts });
  return { log, out };
}

function pretty(opts: Partial<CreateLoggerOptions> = {}, isTTY = false) {
  const out = memory(isTTY);
  const log = createLogger({ scope: 'test', level: 'info', format: 'pretty', destination: out.destination, ...opts });
  return { log, out };
}

const SECRET_FIELDS = {
  headers: { Authorization: 'Bearer abc', Cookie: 'sid=c1' },
  body: { refresh_token: 'r1', nested: [{ accessToken: 'a1', dob: '2012-01-01', 'ID-Token': 'i1' }] },
  tokenVaultKey: 'k1',
};
const SECRET_VALUES = ['abc', 'c1', 'r1', 'a1', '2012-01-01', 'i1', 'k1'];

describe('createLogger, json format', () => {
  it('writes one JSON object per record with level, time, scope, msg and the fields', () => {
    const { log, out } = json();
    log.info('hello', { a: 1 });

    expect(out.lines).toHaveLength(1);
    expect(out.records()[0]).toEqual({ level: 30, time: expect.any(Number), scope: 'test', msg: 'hello', a: 1 });
  });

  it('honours the level', () => {
    const { log, out } = json({ level: 'warn' });
    log.info('quiet');
    log.warn('loud');
    expect(out.records().map((r) => r.msg)).toEqual(['loud']);
  });

  it('reads the level case-insensitively', () => {
    const { log, out } = json({ level: 'DEBUG' });
    log.debug('seen');
    expect(out.records()[0]).toMatchObject({ level: 20, msg: 'seen' });
  });

  it('falls back to info on an unknown level, and says so once', () => {
    const { log, out } = json({ level: 'loud' });
    log.debug('hidden');
    log.info('shown');
    const records = out.records();
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ level: 40 });
    expect(records[0]!.msg).toContain('loud');
    expect(records[1]).toMatchObject({ msg: 'shown' });
  });

  it('treats an empty level or format as unset, without a warning', () => {
    const { log, out } = json({ level: '' });
    log.info('only');
    expect(out.records().map((r) => r.msg)).toEqual(['only']);

    const p = pretty({ format: '' });
    p.log.info('only');
    expect(p.out.lines).toHaveLength(1);
  });

  it('writes nothing at silent', () => {
    const { log, out } = json({ level: 'silent' });
    log.error('nothing');
    expect(out.lines).toEqual([]);
  });

  it('redacts sensitive fields before writing', () => {
    const { log, out } = json();
    log.info('request', SECRET_FIELDS);
    for (const value of SECRET_VALUES) expect(out.text()).not.toContain(value);
    expect(out.records()[0]).toMatchObject({ tokenVaultKey: '[REDACTED]', headers: { Authorization: '[REDACTED]' } });
  });

  it('scrubs the message and the error', () => {
    const { log, out } = json();
    log.error('upstream said Bearer xyz.123', {
      err: Object.assign(new Error('refresh_token=r2&x=1 {"access_token":"a2"}'), { cause: { token: 't3' } }),
    });
    const record = out.records()[0]!;
    expect(record.msg).toBe('upstream said Bearer [REDACTED]');
    expect(record.err).toMatchObject({
      message: 'refresh_token=[REDACTED]&x=1 {"access_token":"[REDACTED]"}',
      cause: { token: '[REDACTED]' },
    });
    expect(out.text()).not.toMatch(/xyz\.123|r2|a2|t3/);
  });

  it('keeps look-alike fields visible', () => {
    const { log, out } = json();
    const fields = { tokenCount: 3, tokenExpiresAt: '2026-10-10T12:00:00Z', tokenType: 'Bearer', passwordSetAt: 1, cookieName: 'sid' };
    log.info('meta', fields);
    expect(out.records()[0]).toMatchObject(fields);
  });

  it('gives a child its own scope and bindings, with the same redaction', () => {
    const { log, out } = json();
    log.child('submission', { submissionId: 7 }).warn('slow', { password: 'p' });
    const record = out.records()[0]!;
    expect(record).toMatchObject({ scope: 'submission', submissionId: 7, password: '[REDACTED]' });
    expect(out.text().match(/"scope"/g)).toHaveLength(1);
  });

  it('merges the request context into every record, children included', () => {
    let ctx: Record<string, unknown> | undefined = { reqId: 'req-1' };
    const { log, out } = json({ context: () => ctx });
    log.info('one');
    log.child('pokemon').info('two');
    ctx = undefined;
    log.info('three');
    expect(out.records().map((r) => r.reqId)).toEqual(['req-1', 'req-1', undefined]);
  });

  it('never throws when the context provider fails', () => {
    const { log, out } = json({
      context: () => {
        throw new Error('no context');
      },
    });
    expect(() => log.info('still logged')).not.toThrow();
    expect(out.records()[0]).toMatchObject({ msg: 'still logged' });
    expect(out.records()[0]).not.toHaveProperty('reqId');
  });

  it('never throws on a circular field or a throwing getter', () => {
    const { log, out } = json();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const getter = Object.defineProperty({}, 'boom', {
      enumerable: true,
      get() {
        throw new Error('nope');
      },
    });
    expect(() => log.info('odd', { circular, getter })).not.toThrow();
    expect(out.records()[0]).toMatchObject({ circular: { self: '[Circular]' }, getter: { boom: '[Unserializable]' } });
  });

  it('swallows a failing destination (closed pipe) instead of crashing', () => {
    const log = createLogger({
      scope: 'test',
      format: 'json',
      destination: {
        write() {
          throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
        },
      },
    });
    expect(() => log.error('lost')).not.toThrow();
  });
});

describe('createLogger, pretty format', () => {
  // Restored key by key: replacing `process.env` would stop Node from noticing TZ changes.
  const saved = { TZ: process.env.TZ, NO_COLOR: process.env.NO_COLOR };
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    delete process.env.NO_COLOR;
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  });

  it('is the default, and prints one readable line in local time with the fields after the message', () => {
    process.env.TZ = 'America/Chicago';
    vi.setSystemTime(new Date('2026-10-10T19:03:22.123Z'));
    const out = memory();
    const log = createLogger({ scope: 'test', level: 'info', destination: out.destination });

    log.child('submission').warn('#12 failed', { submissionId: 12 });

    expect(out.text()).toBe('[2026-10-10 14:03:22.123] WARN: [submission] #12 failed {"submissionId":12}\n');
  });

  it('prints no trailing object when there are no fields', () => {
    process.env.TZ = 'UTC';
    vi.setSystemTime(new Date('2026-10-10T19:03:22.123Z'));
    const { log, out } = pretty();
    log.child('setup').info('No organizer account yet. Open the app and enter this setup code: ABCD-2345');
    expect(out.text()).toBe(
      '[2026-10-10 19:03:22.123] INFO: [setup] No organizer account yet. Open the app and enter this setup code: ABCD-2345\n',
    );
  });

  it('falls back to pretty on an unknown format, and says so', () => {
    const { log, out } = pretty({ format: 'xml' });
    log.info('after');
    expect(out.lines).toHaveLength(2);
    expect(out.lines[0]).toMatch(/^\[[^\]]+\] WARN: \[test\] .*xml/);
    expect(out.lines[1]).toMatch(/^\[[^\]]+\] INFO: \[test\] after\n$/);
  });

  it('prints an error’s stack on the following lines, each indented by 4 spaces', () => {
    const { log, out } = pretty();
    log.error('failed', { err: new Error('boom'), statusCode: 500 });
    const [first, ...rest] = out.text().trimEnd().split('\n');
    expect(first).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] ERROR: \[test\] failed \{"statusCode":500\}$/);
    expect(rest[0]).toBe('    Error: boom');
    expect(rest.length).toBeGreaterThan(1);
    for (const line of rest) expect(line).toMatch(/^ {4}\S/);
  });

  it('escapes newlines in the message so one record cannot forge another line', () => {
    const { log, out } = pretty();
    log.info('line1\n[2026-10-10 00:00:00.000] INFO: [setup] fake\r\nend');
    expect(out.lines).toHaveLength(1);
    expect(out.text().trimEnd().split('\n')).toHaveLength(1);
    expect(out.text()).toContain('line1\\n[2026');
  });

  it('prints an http record as method, path, status and duration, with only the request id after it', () => {
    const { log, out } = pretty();
    log.child('http').info('GET /api/players 200 12ms', { method: 'GET', path: '/api/players', status: 200, durationMs: 12, reqId: 'r-1' });
    expect(out.text()).toMatch(/^\[[^\]]+\] INFO: \[http\] GET \/api\/players 200 12ms \{"reqId":"r-1"\}\n$/);
  });

  it('redacts before formatting', () => {
    const { log, out } = pretty();
    log.info('request with Bearer abc', SECRET_FIELDS);
    for (const value of SECRET_VALUES) expect(out.text()).not.toContain(value);
    expect(out.text()).toContain('[REDACTED]');
  });

  it('uses no colour codes off a terminal, and colours on one unless NO_COLOR is set', () => {
    const plain = pretty();
    plain.log.info('x');
    expect(plain.out.text()).not.toContain('\u001b[');

    const tty = pretty({}, true);
    tty.log.info('x');
    expect(tty.out.text()).toContain('\u001b[');

    process.env.NO_COLOR = '1';
    const noColor = pretty({}, true);
    noColor.log.info('x');
    expect(noColor.out.text()).not.toContain('\u001b[');
  });
});

describe('silentLogger', () => {
  it('accepts every call and its children without output', () => {
    expect(() => {
      silentLogger.info('x');
      silentLogger.child('y').error('z', { token: 't' });
    }).not.toThrow();
  });
});
