import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyKitDockerAssets } from './kit-docker-assets';

/*
 * The entrypoint is the kit's (ADR-0014, A6), and its behaviour is the kit's to test: its host tests
 * (test/docker/entrypoint.test.ts) and container tests (test/entrypoint/run.sh) cover refusals, UMASK,
 * quoting, URL redaction, restore and replicate (kit ADR-0008). What stays here is attendance's own contract
 * with it: the log lines the Unraid guide tells operators to look for, the config path the image uses, and the
 * exit status of a failing app (no kit test pins it yet: selfhost-kit#28). The root path (chown + gosu) and real Litestream are covered in CI by the
 * unchanged test/docker/smoke.sh, litestream.sh and restore-drill.sh.
 */
const assets = copyKitDockerAssets();
const ENTRYPOINT = assets.path('entrypoint.sh');
afterAll(() => assets.remove());

const GUIDE = readFileSync('docs/deploy/unraid.md', 'utf8');
const IMAGE_CONFIG_PATH = readFileSync('Dockerfile', 'utf8').match(/^COPY --from=\S+ \S+\/litestream\.yml (\S+)$/m)?.[1];

/**
 * A stand-in for the litestream binary: records each call (argv), simulates the restore outcome chosen by
 * STUB_RESTORE, and runs the -exec command the way `litestream replicate -exec` does.
 */
const LITESTREAM_STUB = `#!/bin/sh
{ printf 'call:'; for a in "$@"; do printf ' [%s]' "$a"; done; echo; } >> "$STUB_LOG"
case "$1" in
  restore)
    case "$STUB_RESTORE" in
      found) for last in "$@"; do :; done; echo restored > "$last" ;;
    esac
    exit 0 ;;
  replicate)
    while [ $# -gt 0 ]; do
      if [ "$1" = -exec ]; then eval "set -- $2"; "$@"; exit $?; fi
      shift
    done
    exit 99 ;;
esac
exit 98
`;

describe.runIf(process.getuid?.() !== 0)('the kit entrypoint as attendance’s image runs it (non-root)', () => {
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

  const start = (env: Record<string, string>, ...cmd: string[]) =>
    spawnSync('sh', [ENTRYPOINT, ...cmd], {
      env: { PATH: `${dir}:${process.env.PATH}`, STUB_LOG: stubLog, NUXT_DATABASE_PATH: db, ...env },
      encoding: 'utf8',
    });
  const calls = () => (existsSync(stubLog) ? readFileSync(stubLog, 'utf8').split('\n').filter((l) => l.startsWith('call:')) : []);
  /** The entrypoint's own lines, with the temp database path written as the image's /data/app.db. */
  const entrypointLines = (stdout: string) =>
    stdout
      .split('\n')
      .filter((l) => l.startsWith('[entrypoint]'))
      .map((l) => l.replaceAll(db, '/data/app.db'));
  const guideUrl = 's3://<your-bucket>/attendance';

  describe('prints the lines the Unraid guide quotes', () => {
    it('names the database and the replica target when it starts replicating', () => {
      writeFileSync(db, 'existing');
      const lines = entrypointLines(start({ LITESTREAM_REPLICA_URL: guideUrl }, 'true').stdout);
      expect(lines).toEqual([`[entrypoint] litestream: replicating /data/app.db to ${guideUrl}`]);
      expect(GUIDE).toContain(lines[0]);
    });

    it('says it restored the database on a new box', () => {
      const lines = entrypointLines(start({ LITESTREAM_REPLICA_URL: guideUrl, STUB_RESTORE: 'found' }, 'true').stdout);
      expect(lines[1]).toBe('[entrypoint] litestream: restored /data/app.db from replica');
      expect(GUIDE).toContain(lines[1]);
    });

    it('says the replica held nothing when the URL points at an empty one', () => {
      const lines = entrypointLines(start({ LITESTREAM_REPLICA_URL: guideUrl }, 'true').stdout);
      expect(lines[1]).toBe('[entrypoint] litestream: no replica found, starting with an empty database');
      expect(GUIDE).toContain(lines[1].replace('[entrypoint] ', ''));
    });
  });

  it('reads the Litestream config from where the image puts it', () => {
    expect(IMAGE_CONFIG_PATH).toBe('/etc/litestream.yml');
    start({ LITESTREAM_REPLICA_URL: guideUrl }, 'true');
    expect(calls().map((c) => c.split(' ').slice(1, 4).join(' '))).toEqual([
      `[restore] [-config] [${IMAGE_CONFIG_PATH}]`,
      `[replicate] [-config] [${IMAGE_CONFIG_PATH}]`,
    ]);
  });

  it.each([
    ['without a replica URL', {}],
    ['under litestream replicate', { LITESTREAM_REPLICA_URL: guideUrl }],
  ])('passes a failing app’s exit status on %s', (_, env: Record<string, string>) => {
    writeFileSync(db, 'existing');
    expect(start(env, 'sh', '-c', 'exit 3').status).toBe(3);
  });
});
