import { type CreateLoggerOptions, type LogFormat, createRedactor } from '@towerism/selfhost-kit';
import { describeRedactionContract } from '@towerism/selfhost-kit/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTENDANCE_LOG_KEYS, createAppLogger, redactor } from './app-logger';

/** Every key attendance hid before the kit, normalized (its SENSITIVE_KEYS at 8c02618). */
const TODAYS_KEYS = [
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'password',
  'sessionpassword',
  'nuxtsessionpassword',
  'secret',
  'clientsecret',
  'secretaccesskey',
  'litestreamsecretaccesskey',
  'tokenvaultkey',
  'nuxttokenvaultkey',
  'tdfvaultkey',
  'nuxttdfvaultkey',
  'codeverifier',
  'authorizationcode',
  'birthdate',
  'dateofbirth',
  'dob',
  'content',
  'payload',
];

/** Names that look sensitive but must stay readable in the log. */
const LOOK_ALIKES = [
  'tokenCount',
  'tokenExpiresAt',
  'tokenType',
  'passwordSetAt',
  'cookieName',
  'code',
  'state',
  'playerId',
  'contentType',
  'contentLength',
  'payloadSize',
];

function memory() {
  const lines: string[] = [];
  return {
    lines,
    text: () => lines.join(''),
    destination: { write: (line: string) => void lines.push(line), isTTY: false },
  };
}

describe("attendance's log keys", () => {
  it('are the TDF and secret names the kit does not hide on its own', () => {
    expect(ATTENDANCE_LOG_KEYS).toEqual([
      'birthdate',
      'dateOfBirth',
      'dob',
      'content',
      'payload',
      'NUXT_SESSION_PASSWORD',
      'SESSION_PASSWORD',
      'NUXT_TOKEN_VAULT_KEY',
      'TOKEN_VAULT_KEY',
      'NUXT_TDF_VAULT_KEY',
      'TDF_VAULT_KEY',
    ]);
  });

  it.each(TODAYS_KEYS)('still hides %s', (key) => {
    expect(redactor.isSensitiveKey(key)).toBe(true);
  });

  it.each(LOOK_ALIKES)('keeps the look-alike %s visible', (key) => {
    expect(redactor.isSensitiveKey(key)).toBe(false);
  });
});

describeRedactionContract(redactor, {
  mustHide: ['birthDate', 'dateOfBirth', 'dob', 'content', 'payload', 'tokenVaultKey', 'tdfVaultKey', 'NUXT_TOKEN_VAULT_KEY', 'NUXT_TDF_VAULT_KEY'],
  mustShow: LOOK_ALIKES,
});

describe('createAppLogger', () => {
  const FIELDS = { dob: '2012-01-01', content: '<tournament>tdf-body</tournament>', tdfVaultKey: 'tdf-key-1', token: 'tok-1' };
  const VALUES = Object.values(FIELDS);

  it.each<LogFormat>(['json', 'pretty'])("hides attendance's keys and the kit's in %s output", (format) => {
    const out = memory();
    createAppLogger({ scope: 'test', level: 'info', format, destination: out.destination }).info('upload', FIELDS);
    for (const value of VALUES) expect(out.text()).not.toContain(value);
    expect(out.text().match(/\[REDACTED\]/g)).toHaveLength(VALUES.length);
  });

  it("keeps attendance's redactor even when another one is passed in", () => {
    const out = memory();
    const options = { scope: 'test', level: 'info', format: 'json', destination: out.destination, redactor: createRedactor() };
    createAppLogger(options as unknown as Omit<CreateLoggerOptions, 'redactor'>).info('upload', FIELDS);
    for (const value of VALUES) expect(out.text()).not.toContain(value);
  });

  describe('the setup-code line', () => {
    const savedTz = process.env.TZ;
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
    });
    afterEach(() => {
      vi.useRealTimers();
      if (savedTz === undefined) Reflect.deleteProperty(process.env, 'TZ');
      else process.env.TZ = savedTz;
    });

    it('is printed byte for byte, as the container smoke test and the organizer look for it', () => {
      process.env.TZ = 'UTC';
      vi.setSystemTime(new Date('2026-10-10T19:03:22.123Z'));
      const out = memory();
      createAppLogger({ scope: 'app', level: 'info', format: 'pretty', destination: out.destination })
        .child('setup')
        .info('No organizer account yet. Open the app and enter this setup code: ABCD-2345');
      expect(out.text()).toBe(
        '[2026-10-10 19:03:22.123] INFO: [setup] No organizer account yet. Open the app and enter this setup code: ABCD-2345\n',
      );
    });
  });
});
