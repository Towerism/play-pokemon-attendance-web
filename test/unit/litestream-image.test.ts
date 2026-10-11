import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** ADR-0002 / ADR-0006: optional Litestream ships in the `app` image, configured only from env. */
const dockerfile = readFileSync('Dockerfile', 'utf8');
const appStage = dockerfile.slice(dockerfile.indexOf('AS app-build'));
const configPath = 'docker/litestream.yml';

describe('shipped Litestream config', () => {
  it('exists and is copied to the path the entrypoint uses', () => {
    expect(existsSync(configPath)).toBe(true);
    expect(appStage).toMatch(/^COPY docker\/litestream\.yml \/etc\/litestream\.yml$/m);
  });

  const settings = () =>
    readFileSync(configPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#'));

  it('replicates exactly one database, the app DB, to the URL from env', () => {
    expect(settings()).toEqual(['dbs:', '  - path: ${NUXT_DATABASE_PATH}', '    replica:', '      url: ${LITESTREAM_REPLICA_URL}']);
  });

  it('holds no credentials (Litestream reads the keys from env)', () => {
    expect(settings().join('\n')).not.toMatch(/access-key|secret/i);
  });
});

describe('Litestream binary in the app image', () => {
  const arg = (name: string) => appStage.match(new RegExp(`^ARG ${name}=(\\S+)$`, 'm'))?.[1];

  it('pins a release version', () => {
    expect(arg('LITESTREAM_VERSION')).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it.each(['amd64', 'arm64'])('pins a SHA-256 for %s and fails the build on a mismatch', (arch) => {
    expect(arg(`LITESTREAM_SHA256_${arch}`)).toMatch(/^[0-9a-f]{64}$/);
    expect(appStage).toMatch(/sha256sum -c -/);
  });

  it('downloads from the official GitHub release', () => {
    expect(appStage).toContain('https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/');
  });

  it('bakes no Litestream setting or secret into the image env', () => {
    const envBlock = appStage.slice(appStage.indexOf('\nENV '), appStage.indexOf('\nVOLUME'));
    expect(envBlock).not.toMatch(/LITESTREAM_/);
  });
});
