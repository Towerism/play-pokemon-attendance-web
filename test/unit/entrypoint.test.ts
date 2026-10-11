import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

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
