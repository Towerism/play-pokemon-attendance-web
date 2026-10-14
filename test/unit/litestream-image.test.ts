import { existsSync, readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { copyKitDockerAssets } from './kit-docker-assets';

/**
 * ADR-0002 / ADR-0006 / ADR-0014 (A6): optional Litestream ships in the `app` image, configured only from env. The
 * entrypoint, the Litestream config and its installer are the kit's, copied out of node_modules at build time.
 */
const dockerfile = readFileSync('Dockerfile', 'utf8');

/** The text of one build stage, from its `FROM … AS <name>` line up to the next `FROM`. */
const stage = (name: string) => {
  const start = dockerfile.search(new RegExp(`^FROM \\S+ AS ${name}$`, 'm'));
  if (start < 0) return '';
  const next = dockerfile.slice(start + 1).search(/^FROM /m);
  return next < 0 ? dockerfile.slice(start) : dockerfile.slice(start, start + 1 + next);
};

// The config the image gets: the kit's, copied by `selfhost-kit docker-assets`.
const assets = copyKitDockerAssets();
const configPath = assets.path('litestream.yml');
afterAll(() => assets.remove());

describe('shipped Litestream config', () => {
  it('exists and is copied to the path the entrypoint uses', () => {
    expect(existsSync(configPath)).toBe(true);
    expect(stage('app')).toMatch(/^COPY --from=app-deps \/opt\/selfhost-kit\/litestream\.yml \/etc\/litestream\.yml$/m);
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

describe('Docker assets from the kit', () => {
  it('copies them out of node_modules right after the dependency install, before the build context', () => {
    const deps = stage('app-deps');
    const install = deps.indexOf('pnpm install --frozen-lockfile');
    const copy = deps.search(/^RUN pnpm exec selfhost-kit docker-assets \/opt\/selfhost-kit$/m);
    expect(install).toBeGreaterThan(-1);
    expect(copy).toBeGreaterThan(install);
    expect(deps).not.toMatch(/^COPY \. \./m);
    expect(stage('app-build')).toMatch(/^FROM app-deps AS app-build$/m);
  });

  it('runs the kit’s entrypoint', () => {
    expect(stage('app')).toMatch(/^COPY --from=app-deps \/opt\/selfhost-kit\/entrypoint\.sh \/usr\/local\/bin\/entrypoint\.sh$/m);
    expect(stage('app')).toMatch(/^ENTRYPOINT \["tini", "--", "entrypoint\.sh"\]$/m);
  });

  it('keeps no local copy of them', () => {
    expect(dockerfile).not.toMatch(/^COPY (\S+ )*docker\//m);
    for (const name of ['entrypoint.sh', 'litestream.yml', 'fetch-litestream.sh']) {
      expect(existsSync(`docker/${name}`), `docker/${name}`).toBe(false);
    }
  });
});

describe('Litestream binary in the app image', () => {
  const litestream = stage('litestream');

  it('is installed by the kit’s pinned, checksum-verifying installer', () => {
    expect(litestream).toMatch(/^COPY --from=app-deps \/opt\/selfhost-kit\/fetch-litestream\.sh \/tmp\/fetch-litestream\.sh$/m);
    expect(litestream).toMatch(/^RUN sh \/tmp\/fetch-litestream\.sh \/usr\/local\/bin$/m);
    expect(litestream).toMatch(/^ARG TARGETARCH$/m);
    expect(stage('app')).toMatch(/^COPY --from=litestream \/usr\/local\/bin\/litestream \/usr\/local\/bin\/litestream$/m);
  });

  it('has no pin of its own beside the kit’s', () => {
    expect(dockerfile).not.toMatch(/LITESTREAM_(VERSION|SHA256)/);
    expect(dockerfile).not.toContain('github.com/benbjohnson/litestream');
  });

  it('bakes no Litestream setting or secret into the image env', () => {
    const app = stage('app');
    const envBlock = app.slice(app.indexOf('\nENV '), app.indexOf('\nVOLUME'));
    expect(envBlock).toContain('NUXT_DATABASE_PATH=/data/app.db');
    expect(envBlock).not.toMatch(/LITESTREAM_/);
  });
});
