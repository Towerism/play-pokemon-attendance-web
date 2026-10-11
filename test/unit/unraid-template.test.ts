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
  value?: string;
}

const config = (target: string) => {
  const c = container.Config.find((x) => x.Target === target);
  if (!c) throw new Error(`no Config with Target=${target}`);
  return c;
};

const dockerfileEnv = (name: string) => readFileSync('Dockerfile', 'utf8').match(new RegExp(`\\b${name}=(\\S+)`))?.[1];
const ciImage = readFileSync('.github/workflows/ci.yml', 'utf8').match(/IMAGE_NAME:\s*(\S+)/)?.[1];

describe('Unraid template', () => {
  it('has no required field', () => {
    expect(container.Config.filter((c) => c.Required !== 'false').map((c) => c.Name)).toEqual([]);
  });

  it('pulls the image CI publishes', () => {
    expect(ciImage).toBeDefined();
    expect(container.Repository).toBe(`${ciImage}:latest`);
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

  it('never asks for Pokémon or organizer credentials (set up in the browser)', () => {
    const targets = container.Config.map((c) => c.Target);
    expect(targets.filter((t) => /password|user|token/i.test(t))).toEqual(['NUXT_SESSION_PASSWORD', 'NUXT_TOKEN_VAULT_KEY']);
  });

  it('does not set TZ itself (Unraid injects it)', () => {
    expect(container.Config.map((c) => c.Target)).not.toContain('TZ');
  });
});
