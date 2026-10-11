import { describe, expect, it } from 'vitest';
import { DEFAULT_TRUSTED_PROXIES, InvalidTrustedProxiesError, clientKey, normalizeAddress, parseTrustedProxies } from './client-address';

describe('clientKey (X-Forwarded-For is only believed from a trusted proxy)', () => {
  const trusted = parseTrustedProxies(DEFAULT_TRUSTED_PROXIES);
  const key = (remoteAddress: string | undefined, xForwardedFor: string | undefined) => clientKey({ remoteAddress, xForwardedFor, trusted });

  it.each([
    ['ignores a forged header from an untrusted (direct LAN) peer', '192.168.1.50', '1.2.3.4', '192.168.1.50'],
    ['uses the peer when a trusted proxy sends no header', '172.18.0.5', undefined, '172.18.0.5'],
    ['uses the peer when the header is empty', '172.18.0.5', '', '172.18.0.5'],
    ["uses Caddy's single entry", '172.18.0.5', '192.168.1.20', '192.168.1.20'],
    ['uses the rightmost entry; entries to its left are client-supplied', '172.18.0.5', '6.6.6.6, 192.168.1.20', '192.168.1.20'],
    ['skips trusted hops from the right', '172.18.0.5', '203.0.113.9, 172.19.0.2', '203.0.113.9'],
    ['uses the leftmost entry when every entry is trusted', '172.18.0.5', '172.19.0.3, 172.19.0.2', '172.19.0.3'],
    ['stops at the first valid untrusted entry, ignoring junk further left', '172.18.0.5', 'garbage, 192.168.1.20', '192.168.1.20'],
    ['falls back to the peer when the rightmost entry is malformed', '172.18.0.5', '192.168.1.20, garbage', '172.18.0.5'],
    ['falls back to the peer on an empty entry', '172.18.0.5', '192.168.1.20, ', '172.18.0.5'],
    ['normalizes an IPv4-mapped peer and a bracketed IPv6 entry with a port', '::ffff:127.0.0.1', '[2001:db8::7]:4431', '2001:db8::7'],
    ['lowercases IPv6 entries', '::1', '2001:DB8::7', '2001:db8::7'],
    ['uses unknown when there is no peer address', undefined, '192.168.1.20', 'unknown'],
    ['uses unknown for a malformed peer', 'not-an-ip', undefined, 'unknown'],
    ['treats several joined header lines as one list', '127.0.0.1', '6.6.6.6, 10.9.9.9, 192.168.1.20', '192.168.1.20'],
  ])('%s', (_name, peer, xff, expected) => {
    expect(key(peer, xff)).toBe(expected);
  });

  it('never believes the header when nothing is trusted', () => {
    expect(clientKey({ remoteAddress: '127.0.0.1', xForwardedFor: '192.168.1.20', trusted: parseTrustedProxies('none') })).toBe('127.0.0.1');
  });
});

describe('parseTrustedProxies', () => {
  it('trusts loopback and the Docker bridge pool by default, but not LAN ranges', () => {
    const trusted = parseTrustedProxies(DEFAULT_TRUSTED_PROXIES);
    for (const ip of ['127.0.0.1', '127.255.0.9', '::1', '172.16.0.1', '172.17.0.1', '172.31.255.254']) {
      expect(trusted.contains(ip), ip).toBe(true);
    }
    for (const ip of ['192.168.1.10', '10.0.0.5', '172.32.0.1', '172.15.255.255', '8.8.8.8', '2001:db8::1']) {
      expect(trusted.contains(ip), ip).toBe(false);
    }
  });

  it.each(['', '   '])('treats a blank value (%j, an empty Unraid field) as the default', (value) => {
    const trusted = parseTrustedProxies(value);
    expect(trusted.contains('172.18.0.5')).toBe(true);
    expect(trusted.contains('127.0.0.1')).toBe(true);
    expect(trusted.contains('192.168.1.10')).toBe(false);
  });

  it.each(['none', ' NONE '])('trusts nothing for %j', (value) => {
    const trusted = parseTrustedProxies(value);
    expect(trusted.contains('127.0.0.1')).toBe(false);
    expect(trusted.contains('::1')).toBe(false);
  });

  it('takes single addresses and IPv4/IPv6 ranges, comma-separated', () => {
    const trusted = parseTrustedProxies('192.168.1.5, 2001:db8::/32 ,10.1.0.0/16');
    expect(trusted.contains('192.168.1.5')).toBe(true);
    expect(trusted.contains('192.168.1.6')).toBe(false);
    expect(trusted.contains('2001:db8:ffff::1')).toBe(true);
    expect(trusted.contains('2001:db9::1')).toBe(false);
    expect(trusted.contains('10.1.200.3')).toBe(true);
    expect(trusted.contains('127.0.0.1')).toBe(false);
  });

  it('matches IPv4-mapped IPv6 against IPv4 ranges, and ignores malformed input', () => {
    const trusted = parseTrustedProxies('127.0.0.0/8');
    expect(trusted.contains('::ffff:127.0.0.1')).toBe(true);
    expect(trusted.contains('garbage')).toBe(false);
  });

  it.each(['10.0.0.0/33', 'not-an-ip', '2001:db8::/129', '10.0.0.0/', '10.0.0.1,,10.0.0.2', '10.0.0.0/8, none'])(
    'rejects %j, naming the variable and the bad entry',
    (value) => {
      expect(() => parseTrustedProxies(value)).toThrow(InvalidTrustedProxiesError);
      expect(() => parseTrustedProxies(value)).toThrow(/NUXT_TRUSTED_PROXIES/);
    },
  );

  it('quotes the bad entry in the message', () => {
    expect(() => parseTrustedProxies('10.0.0.5, 10.0.0.0/33')).toThrow(/"10\.0\.0\.0\/33"/);
  });
});

describe('normalizeAddress', () => {
  it.each([
    ['192.168.1.10', '192.168.1.10'],
    ['::ffff:192.168.1.10', '192.168.1.10'],
    ['::FFFF:192.168.1.10', '192.168.1.10'],
    ['192.168.1.10:51234', '192.168.1.10'],
    ['[2001:DB8::1]:443', '2001:db8::1'],
    ['[2001:db8::1]', '2001:db8::1'],
    ['2001:DB8::1', '2001:db8::1'],
    ['fe80::1%eth0', 'fe80::1'],
    ['::1', '::1'],
    ['  10.0.0.1  ', '10.0.0.1'],
  ])('%j → %j', (raw, expected) => {
    expect(normalizeAddress(raw)).toBe(expected);
  });

  it.each([undefined, '', '   ', 'unknown', '_hidden', 'example.com', '999.1.1.1', '1.2.3', '[::1', '1.2.3.4:', '[::1]:x', '1.2.3.4:99999'])(
    'treats %j as malformed',
    (raw) => {
      expect(normalizeAddress(raw)).toBeNull();
    },
  );
});
