import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';

/**
 * docs/deploy/unraid.md is the organizer's install, backup and restore guide.
 * These checks keep it in step with the template and the rest of the docs, so
 * a renamed field or a moved heading fails CI instead of misleading someone
 * in the middle of a restore.
 */
const GUIDE = 'docs/deploy/unraid.md';
const guide = existsSync(GUIDE) ? readFileSync(GUIDE, 'utf8') : '';

const template = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' }).parse(
  readFileSync('deploy/unraid/play-pokemon-attendance.xml', 'utf8'),
) as { Container: { Config: { Target: string; Type: string; Default: string }[] } };
const configs = template.Container.Config;

/** Text outside fenced code blocks: link and heading rules don't apply inside code. */
const prose = (md: string) => md.replace(/^```[\s\S]*?^```/gm, '');

/** GitHub's heading anchors: lowercase, punctuation dropped, spaces to hyphens. */
const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');

const headings = (md: string, level?: number) =>
  [...prose(md).matchAll(/^(#{1,6})\s+(.+?)\s*#*$/gm)]
    .filter((m) => level === undefined || m[1]!.length === level)
    .map((m) => m[2]!);

const relativeLinks = (md: string) =>
  [...prose(md).matchAll(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)]
    .map((m) => ({ text: m[1]!, target: m[2]! }))
    .filter((l) => !/^[a-z][a-z0-9+.-]*:/i.test(l.target));

/** The body of one `## ` section, up to the next `## `. */
const section = (md: string, title: string) => {
  const start = md.search(new RegExp(`^## ${title}\\s*$`, 'm'));
  if (start < 0) return '';
  const rest = md.slice(start + 1);
  const end = rest.search(/^## /m);
  return end < 0 ? rest : rest.slice(0, end);
};

const linksTo = (fromFile: string, target: string) =>
  relativeLinks(readFileSync(fromFile, 'utf8')).some(
    (l) => normalize(join(dirname(fromFile), l.target.split('#')[0]!)) === normalize(target),
  );

describe('Unraid deployment guide', () => {
  it('exists', () => {
    expect(existsSync(GUIDE)).toBe(true);
  });

  it.each(['README.md', 'docs/architecture/README.md'])('is linked from %s', (file) => {
    expect(linksTo(file, GUIDE)).toBe(true);
  });

  it('keeps the README quick install alongside the link', () => {
    expect(section(readFileSync('README.md', 'utf8'), 'Install on Unraid')).toMatch(/\bApply\b/);
  });

  it('documents every field of the Unraid template', () => {
    const missing = configs.map((c) => c.Target).filter((t) => !guide.includes(t));
    expect(missing).toEqual([]);
  });

  it('uses the template default appdata path verbatim', () => {
    const appdata = configs.find((c) => c.Type === 'Path')!.Default;
    expect(guide).toContain(appdata);
  });

  it.each(['LITESTREAM_REPLICA_URL', 'LITESTREAM_ACCESS_KEY_ID', 'LITESTREAM_SECRET_ACCESS_KEY'])(
    'explains the optional Litestream variable %s',
    (name) => {
      expect(section(guide, 'Backup')).toContain(name);
    },
  );

  it.each(['NUXT_POKEMON_ACCESS_URL', 'NUXT_POKEMON_API_URL'])(
    'mentions the test-only %s only to say never to set it',
    (name) => {
      const lines = guide.split('\n').filter((l) => l.includes(name));
      expect(lines.filter((l) => !/never set/i.test(l))).toEqual([]);
    },
  );

  it('has every relative link pointing at a file that exists', () => {
    const broken = relativeLinks(guide)
      .filter((l) => !l.target.startsWith('#'))
      .filter((l) => !existsSync(join(dirname(GUIDE), l.target.split('#')[0]!)))
      .map((l) => `[${l.text}](${l.target})`);
    expect(broken).toEqual([]);
  });

  it('has every #anchor link matching a heading in its target file', () => {
    const broken = relativeLinks(guide)
      .filter((l) => l.target.includes('#'))
      .filter((l) => {
        const [file, anchor] = l.target.split('#') as [string, string];
        const path = file ? join(dirname(GUIDE), file) : GUIDE;
        return !existsSync(path) || !headings(readFileSync(path, 'utf8')).map(slug).includes(anchor);
      })
      .map((l) => `[${l.text}](${l.target})`);
    expect(broken).toEqual([]);
  });

  it('contains nothing that looks like a real key or secret', () => {
    // A generated key is a long base64 or hex run that mixes digits and capitals;
    // the guide's paths and placeholders are lowercase or broken up by punctuation.
    const suspicious = [...guide.matchAll(/[A-Za-z0-9+/=]{32,}/g)]
      .map((m) => m[0])
      .filter((run) => /^[0-9a-f]+$/i.test(run) || (/\d/.test(run) && /[A-Z]/.test(run)));
    expect(suspicious).toEqual([]);
  });

  it('has the sections an organizer needs, in order', () => {
    const required = ['Install', 'Configuration', 'Remote access', 'Updates', 'Backup', 'Restore', 'Restore drill', 'Troubleshooting'];
    expect(headings(guide, 2).filter((h) => required.includes(h))).toEqual(required);
  });

  it('says secrets/ is always restored together with app.db', () => {
    expect(guide).toMatch(/restore `secrets\/` together with `app\.db`/i);
  });

  it('says what losing each generated secret costs', () => {
    expect(guide).toMatch(/vault key[^.]*\breconnect/i);
    expect(guide).toMatch(/session password[^.]*\blog(?:s|ged)? (?:everyone )?out/i);
  });

  describe('restore drill', () => {
    const drill = section(guide, 'Restore drill');
    const appdata = configs.find((c) => c.Type === 'Path')!.Default;

    it('runs on a port other than the live 3000', () => {
      expect([...drill.matchAll(/\b(\d{4,5})\b/g)].map((m) => m[1]).some((p) => p !== '3000')).toBe(true);
    });

    it('restores into an appdata path other than the live one', () => {
      const paths = [...drill.matchAll(/\/mnt\/user\/appdata\/[\w.-]+/g)].map((m) => m[0]);
      expect(paths.some((p) => p !== appdata)).toBe(true);
    });

    it('is run before each league season', () => {
      expect(drill).toMatch(/before each league season/i);
    });
  });
});
