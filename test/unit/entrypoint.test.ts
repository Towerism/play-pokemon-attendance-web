import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The root path (chown + gosu) needs a container: test/docker/smoke.sh covers it in CI.
const run = (env: Record<string, string>, ...cmd: string[]) =>
  spawnSync('sh', ['docker/entrypoint.sh', ...cmd], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });

describe.runIf(process.getuid?.() !== 0)('docker/entrypoint.sh as a non-root user', () => {
  it('runs the command as-is', () => {
    const result = run({}, 'sh', '-c', 'echo "$0 $(umask)"', 'hello');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('hello 0022');
  });

  it('applies UMASK', () => {
    expect(run({ UMASK: '077' }, 'sh', '-c', 'umask').stdout.trim()).toBe('0077');
  });

  it.each([{ PUID: 'nobody' }, { PGID: '100;rm' }])('refuses a non-numeric id %j', (env) => {
    const result = run(env, 'true');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/PUID and PGID must be numeric/);
  });
});

/**
 * A stand-in for the litestream binary: records each call (argv and the env it
 * sees), simulates the restore outcome chosen by STUB_RESTORE, and runs the
 * -exec command the way `litestream replicate -exec` does.
 */
const LITESTREAM_STUB = `#!/bin/sh
{ printf 'call:'; for a in "$@"; do printf ' [%s]' "$a"; done; echo
  echo "env: NUXT_DATABASE_PATH=$NUXT_DATABASE_PATH LITESTREAM_REPLICA_URL=$LITESTREAM_REPLICA_URL"; } >> "$STUB_LOG"
case "$1" in
  restore)
    case "$STUB_RESTORE" in
      found) for last in "$@"; do :; done; echo restored > "$last" ;;
      fail) echo "stub restore: AccessDenied" >&2; exit 1 ;;
    esac
    exit 0 ;;
  replicate)
    if [ -n "$STUB_REPLICATE_FAIL" ]; then echo 'Error: unknown replica type in config: "bogus"' >&2; exit 1; fi
    while [ $# -gt 0 ]; do
      if [ "$1" = -exec ]; then eval "set -- $2"; "$@"; exit $?; fi
      shift
    done
    exit 99 ;;
esac
exit 98
`;

describe.runIf(process.getuid?.() !== 0)('docker/entrypoint.sh with optional Litestream', () => {
  let dir: string;
  let db: string;
  let stubLog: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'entrypoint-litestream-'));
    db = join(dir, 'app.db');
    stubLog = join(dir, 'litestream-calls.log');
    writeFileSync(join(dir, 'litestream'), LITESTREAM_STUB);
    chmodSync(join(dir, 'litestream'), 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const start = (env: Record<string, string>, ...cmd: string[]) => {
    const result = spawnSync('sh', ['docker/entrypoint.sh', ...cmd], {
      env: { PATH: `${dir}:${process.env.PATH}`, STUB_LOG: stubLog, NUXT_DATABASE_PATH: db, ...env },
      encoding: 'utf8',
    });
    return { ...result, output: result.stdout + result.stderr };
  };
  const calls = () => (existsSync(stubLog) ? readFileSync(stubLog, 'utf8').split('\n').filter((l) => l.startsWith('call:')) : []);
  const litestreamEnv = () => readFileSync(stubLog, 'utf8').split('\n').filter((l) => l.startsWith('env:'));
  const withExistingDb = () => writeFileSync(db, 'existing');
  const url = 'file:///backups/attendance';

  describe('when LITESTREAM_REPLICA_URL is not set', () => {
    it('runs the app directly, without litestream and without saying anything about it', () => {
      const result = start({}, 'sh', '-c', 'echo app-ran');
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('app-ran');
      expect(calls()).toEqual([]);
      expect(result.output).not.toMatch(/litestream/i);
    });

    it('treats a whitespace-only URL as unset', () => {
      const result = start({ LITESTREAM_REPLICA_URL: '  \t ' }, 'sh', '-c', 'echo app-ran');
      expect(result.stdout.trim()).toBe('app-ran');
      expect(calls()).toEqual([]);
    });

    it.each(['LITESTREAM_ACCESS_KEY_ID', 'LITESTREAM_SECRET_ACCESS_KEY'])(
      'warns that backups are off when only %s is set, then runs the app directly',
      (key) => {
        const result = start({ [key]: 'SECRET-SENTINEL' }, 'sh', '-c', 'echo app-ran');
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('app-ran');
        expect(calls()).toEqual([]);
        expect(result.output.match(/LITESTREAM_REPLICA_URL is empty; backups are off/g)).toHaveLength(1);
        expect(result.output).not.toContain('SECRET-SENTINEL');
      },
    );
  });

  describe('when LITESTREAM_REPLICA_URL is set and the database exists', () => {
    it('runs the app as the child of litestream replicate with the shipped config', () => {
      withExistingDb();
      const result = start({ LITESTREAM_REPLICA_URL: url }, 'sh', '-c', 'echo app-ran');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('app-ran');
      expect(calls()).toEqual([`call: [replicate] [-config] [/etc/litestream.yml] [-exec] ['sh' '-c' 'echo app-ran']`]);
    });

    it('never restores over an existing database', () => {
      withExistingDb();
      start({ LITESTREAM_REPLICA_URL: url, STUB_RESTORE: 'found' }, 'true');
      expect(calls().some((c) => c.startsWith('call: [restore]'))).toBe(false);
      expect(readFileSync(db, 'utf8')).toBe('existing');
    });

    it('keeps arguments with spaces and quotes intact through -exec', () => {
      withExistingDb();
      const result = start({ LITESTREAM_REPLICA_URL: url }, 'sh', '-c', 'printf "%s|" "$@"', 'x', "it's here", 'a b');
      expect(result.stdout).toContain("it's here|a b|");
    });

    it('logs one line naming the database and the replica target', () => {
      withExistingDb();
      const result = start({ LITESTREAM_REPLICA_URL: url }, 'true');
      expect(result.stdout).toContain(`[entrypoint] litestream: replicating ${db} to ${url}\n`);
    });

    it('never logs credentials, URL userinfo or the query string', () => {
      withExistingDb();
      const result = start(
        {
          LITESTREAM_REPLICA_URL: 's3://user:pw-SENTINEL@bucket/path?endpoint=https://x.example&region=auto',
          LITESTREAM_ACCESS_KEY_ID: 'KEYID-SENTINEL',
          LITESTREAM_SECRET_ACCESS_KEY: 'SECRET-SENTINEL',
        },
        'true',
      );
      expect(result.stdout).toContain(`replicating ${db} to s3://bucket/path\n`);
      for (const leak of ['pw-SENTINEL', 'user:', 'endpoint=', 'region=', 'KEYID-SENTINEL', 'SECRET-SENTINEL']) {
        expect(result.output).not.toContain(leak);
      }
    });

    it('hands litestream the database path and the trimmed URL', () => {
      withExistingDb();
      start({ LITESTREAM_REPLICA_URL: `  ${url}\n` }, 'true');
      expect(litestreamEnv()).toEqual([`env: NUXT_DATABASE_PATH=${db} LITESTREAM_REPLICA_URL=${url}`]);
    });

    it('exits non-zero with litestream’s error when litestream cannot start', () => {
      withExistingDb();
      const result = start({ LITESTREAM_REPLICA_URL: 'bogus://nowhere', STUB_REPLICATE_FAIL: '1' }, 'sh', '-c', 'echo app-ran');
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain('app-ran');
      expect(result.stderr).toContain('unknown replica type');
    });

    it('passes a failing app’s exit status on', () => {
      withExistingDb();
      expect(start({ LITESTREAM_REPLICA_URL: url }, 'sh', '-c', 'exit 3').status).not.toBe(0);
    });
  });

  describe('when LITESTREAM_REPLICA_URL is set and the database is missing', () => {
    it('restores from the replica before starting the app, and says so', () => {
      const result = start({ LITESTREAM_REPLICA_URL: url, STUB_RESTORE: 'found' }, 'sh', '-c', 'echo app-ran');
      expect(result.status).toBe(0);
      expect(calls()).toEqual([
        `call: [restore] [-config] [/etc/litestream.yml] [-if-db-not-exists] [-if-replica-exists] [${db}]`,
        `call: [replicate] [-config] [/etc/litestream.yml] [-exec] ['sh' '-c' 'echo app-ran']`,
      ]);
      expect(readFileSync(db, 'utf8')).toBe('restored\n');
      expect(result.stdout).toContain(`[entrypoint] litestream: restored ${db} from replica\n`);
      expect(result.stdout).toContain('app-ran');
    });

    it('starts with an empty database when the replica holds nothing', () => {
      const result = start({ LITESTREAM_REPLICA_URL: url }, 'sh', '-c', 'echo app-ran');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('[entrypoint] litestream: no replica found, starting with an empty database\n');
      expect(result.stdout).toContain('app-ran');
      expect(result.stdout).not.toContain('restored');
    });

    it('exits non-zero without starting the app when the restore fails', () => {
      const result = start({ LITESTREAM_REPLICA_URL: url, STUB_RESTORE: 'fail' }, 'sh', '-c', 'echo app-ran');
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain('app-ran');
      expect(result.stderr).toContain('AccessDenied');
      expect(calls().some((c) => c.startsWith('call: [replicate]'))).toBe(false);
    });

    it('uses /data/app.db when NUXT_DATABASE_PATH is unset', () => {
      const result = start({ LITESTREAM_REPLICA_URL: url, NUXT_DATABASE_PATH: '' }, 'true');
      expect(calls()[0]).toBe('call: [restore] [-config] [/etc/litestream.yml] [-if-db-not-exists] [-if-replica-exists] [/data/app.db]');
      expect(litestreamEnv()[0]).toBe(`env: NUXT_DATABASE_PATH=/data/app.db LITESTREAM_REPLICA_URL=${url}`);
      expect(result.stdout).toContain('replicating /data/app.db to');
    });
  });
});
