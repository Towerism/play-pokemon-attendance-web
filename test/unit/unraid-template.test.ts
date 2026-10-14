import { readFileSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';

/** ADR-0006: install = Add Container → Apply. Nothing required, everything under /data. */
const xml = readFileSync('deploy/unraid/play-pokemon-attendance.xml', 'utf8');
const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', textNodeName: 'value', parseTagValue: false })
  .parse(xml) as { Container: Record<string, unknown> & { Config: Config[] } };
const container = parsed.Container;

interface Config {
  Name: string;
  Target: string;
  Default: string;
  Type: 'Port' | 'Path' | 'Variable' | 'Label' | 'Device';
  Display: 'always' | 'advanced' | 'always-hide' | 'advanced-hide';
  Required: 'true' | 'false';
  Mask: 'true' | 'false';
  Description: string;
  value?: string;
}

const config = (target: string) => {
  const c = container.Config.find((x) => x.Target === target);
  if (!c) throw new Error(`no Config with Target=${target}`);
  return c;
};

const dockerfileEnv = (name: string) => readFileSync('Dockerfile', 'utf8').match(new RegExp(`\\b${name}=(\\S+)`))?.[1];
/** The image-name inputs CI passes to the kit's image and release workflows (comment lines don't count). */
const ciImageNames = [...readFileSync('.github/workflows/ci.yml', 'utf8').matchAll(/^\s+image-name:\s*(\S+)\s*$/gm)].map((m) => m[1]);

describe('Unraid template', () => {
  it('has no required field', () => {
    expect(container.Config.filter((c) => c.Required !== 'false').map((c) => c.Name)).toEqual([]);
  });

  it('pulls the image CI publishes and releases', () => {
    // One for the image job, one for the release job, naming the same image.
    expect(ciImageNames).toHaveLength(2);
    expect(new Set(ciImageNames).size).toBe(1);
    expect(container.Repository).toBe(`${ciImageNames[0]}:latest`);
  });

  it('opens the WebUI on the container port 3000', () => {
    expect(container.WebUI).toBe('http://[IP]:[PORT:3000]/');
    expect(config('3000')).toMatchObject({ Type: 'Port', Default: '3000', value: '3000' });
  });

  it('keeps everything persistent in one appdata folder mounted at /data', () => {
    const paths = container.Config.filter((c) => c.Type === 'Path');
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatchObject({
      Target: '/data',
      Default: '/mnt/user/appdata/play-pokemon-attendance',
      value: '/mnt/user/appdata/play-pokemon-attendance',
    });
  });

  it.each([
    ['PUID', '99'],
    ['PGID', '100'],
    ['UMASK', '022'],
  ])('defaults %s to %s, same as the image', (name, value) => {
    expect(config(name)).toMatchObject({ Default: value, value });
    expect(dockerfileEnv(name)).toBe(value);
  });

  it.each(['NUXT_SESSION_PASSWORD', 'NUXT_TOKEN_VAULT_KEY'])(
    'offers %s only as an empty, masked, advanced override (generated on first boot otherwise)',
    (name) => {
      expect(config(name)).toMatchObject({ Display: 'advanced', Mask: 'true', Default: '' });
      expect(config(name).value ?? '').toBe('');
    },
  );

  it('offers NUXT_TRUSTED_PROXIES as an optional, unmasked, advanced field that is blank by default', () => {
    expect(config('NUXT_TRUSTED_PROXIES')).toMatchObject({
      Type: 'Variable',
      Display: 'advanced',
      Required: 'false',
      Mask: 'false',
      Default: '',
    });
    expect(config('NUXT_TRUSTED_PROXIES').value ?? '').toBe('');
    expect(config('NUXT_TRUSTED_PROXIES').Description).toMatch(/docs\/deploy\/unraid\.md/);
  });

  it('never asks for Pokémon or organizer credentials (set up in the browser)', () => {
    const targets = container.Config.map((c) => c.Target);
    expect(targets.filter((t) => /password|user|token/i.test(t))).toEqual(['NUXT_SESSION_PASSWORD', 'NUXT_TOKEN_VAULT_KEY']);
  });

  it.each([
    ['LITESTREAM_REPLICA_URL', 'false'],
    ['LITESTREAM_ACCESS_KEY_ID', 'true'],
    ['LITESTREAM_SECRET_ACCESS_KEY', 'true'],
  ])('offers %s as an empty, optional, advanced field (mask=%s) for off-box backups', (name, mask) => {
    expect(config(name)).toMatchObject({ Type: 'Variable', Display: 'advanced', Required: 'false', Default: '', Mask: mask });
    expect(config(name).value ?? '').toBe('');
    expect((config(name) as Config & { Description: string }).Description).toContain('docs/deploy/unraid.md');
  });

  it('does not set TZ itself (Unraid injects it)', () => {
    expect(container.Config.map((c) => c.Target)).not.toContain('TZ');
  });
});
