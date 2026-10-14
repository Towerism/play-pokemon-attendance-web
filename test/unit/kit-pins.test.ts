import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { kitPinProblems } from './kit-pins';

/**
 * The kit is pinned three times: package.json's exact version and the two reusable workflows in ci.yml (full commit
 * SHA + `# vX.Y.Z`). Renovate moves them as one group and automerges it, so this check is the required status that
 * stops a half-moved bump (npm seen before the git tag, or the reverse) from merging and releasing.
 */
const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

const kitUse = (workflow: string, ref = SHA, comment = ' # v0.4.2') =>
  `    uses: Towerism/selfhost-kit/.github/workflows/${workflow}@${ref}${comment}\n`;
const ciYaml = (...uses: string[]) => `jobs:\n  image:\n${uses[0] ?? ''}  release:\n${uses[1] ?? ''}`;
const pins = (overrides: { kitVersion?: string; workflows?: Record<string, string> } = {}) => ({
  kitVersion: '0.4.2',
  workflows: { 'ci.yml': ciYaml(kitUse('app-image.yml'), kitUse('app-release.yml')) },
  ...overrides,
});

describe('kit pins', () => {
  it('accepts an exact version with every workflow on one SHA tagged with that version', () => {
    expect(kitPinProblems(pins())).toEqual([]);
  });

  it.each(['^0.4.2', '~0.4.2', '0.4', 'latest', undefined])('rejects a package.json version that is not exact (%s)', (kitVersion) => {
    expect(kitPinProblems(pins({ kitVersion })).join('\n')).toMatch(/not an exact version/);
  });

  it('rejects workflows pinned to different SHAs', () => {
    const workflows = { 'ci.yml': ciYaml(kitUse('app-image.yml'), kitUse('app-release.yml', OTHER_SHA)) };
    expect(kitPinProblems(pins({ workflows })).join('\n')).toMatch(/different commits/);
  });

  it('rejects SHAs that differ across workflow files', () => {
    const workflows = { 'a.yml': ciYaml(kitUse('app-image.yml')), 'b.yml': ciYaml(kitUse('app-release.yml', OTHER_SHA)) };
    expect(kitPinProblems(pins({ workflows })).join('\n')).toMatch(/different commits/);
  });

  it('rejects a workflow comment that names another version than package.json, naming both', () => {
    const workflows = { 'ci.yml': ciYaml(kitUse('app-image.yml'), kitUse('app-release.yml', SHA, ' # v0.4.1')) };
    const problems = kitPinProblems(pins({ workflows })).join('\n');
    expect(problems).toMatch(/v0\.4\.1/);
    expect(problems).toMatch(/0\.4\.2/);
  });

  it.each([
    ['a tag', 'v0.4.2', ' # v0.4.2'],
    ['a branch', 'main', ''],
    ['a short SHA', 'a'.repeat(7), ' # v0.4.2'],
    ['a SHA with no version comment', SHA, ''],
  ])('rejects a workflow pinned to %s', (_, ref, comment) => {
    const workflows = { 'ci.yml': ciYaml(kitUse('app-image.yml'), kitUse('app-release.yml', ref, comment)) };
    expect(kitPinProblems(pins({ workflows })).join('\n')).toMatch(/app-release\.yml.*not pinned/);
  });

  it('rejects workflows that use no kit workflow at all, so a move cannot pass vacuously', () => {
    const workflows = { 'ci.yml': 'jobs:\n  check:\n    steps:\n      - uses: actions/checkout@v5\n' };
    expect(kitPinProblems(pins({ workflows })).join('\n')).toMatch(/no workflow uses/);
  });

  it('holds for the repository as committed', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> };
    const dir = '.github/workflows';
    const workflows = Object.fromEntries(
      readdirSync(dir)
        .filter((f) => /\.ya?ml$/.test(f))
        .map((f) => [f, readFileSync(`${dir}/${f}`, 'utf8')]),
    );
    expect(kitPinProblems({ kitVersion: pkg.dependencies['@towerism/selfhost-kit'], workflows })).toEqual([]);
  });
});
