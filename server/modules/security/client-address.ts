import { BlockList, isIP } from 'node:net';

/**
 * A normalized IP address, or `null` when malformed. Accepts what proxies put
 * in `X-Forwarded-For`: brackets, a port, an IPv6 zone, IPv4-mapped IPv6.
 */
export function normalizeAddress(raw: string | undefined): string | null {
  let value = raw?.trim() ?? '';
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
  if (bracketed) {
    if (bracketed[2] !== undefined && !validPort(bracketed[2])) return null;
    value = bracketed[1]!;
  } else {
    const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d*)$/.exec(value);
    if (withPort) {
      if (!validPort(withPort[2]!)) return null;
      value = withPort[1]!;
    }
  }
  value = value.replace(/%[^%]*$/, '').toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped) value = mapped[1]!;
  return isIP(value) ? value : null;
}

export const DEFAULT_TRUSTED_PROXIES = '127.0.0.0/8,::1/128,172.16.0.0/12';

export class InvalidTrustedProxiesError extends Error {
  override name = 'InvalidTrustedProxiesError';
}

export interface TrustedProxies {
  contains(ip: string): boolean;
}

/**
 * `NUXT_TRUSTED_PROXIES`: comma-separated addresses or CIDR ranges, `none`,
 * or blank for the default (Unraid passes an empty field as an empty value).
 */
export function parseTrustedProxies(value: string): TrustedProxies {
  const trimmed = value.trim();
  const list = new BlockList();
  if (trimmed.toLowerCase() === 'none') return contains(list);

  for (const raw of (trimmed || DEFAULT_TRUSTED_PROXIES).split(',')) {
    const entry = raw.trim();
    const [address = '', prefix, ...rest] = entry.split('/');
    const family = isIP(address);
    const bits = Number(prefix);
    const maxBits = family === 6 ? 128 : 32;
    if (!family || rest.length > 0) throw invalid(entry);
    if (prefix === undefined) {
      list.addAddress(address, family === 6 ? 'ipv6' : 'ipv4');
    } else if (/^\d{1,3}$/.test(prefix) && bits <= maxBits) {
      list.addSubnet(address, bits, family === 6 ? 'ipv6' : 'ipv4');
    } else {
      throw invalid(entry);
    }
  }
  return contains(list);
}

function contains(list: BlockList): TrustedProxies {
  return {
    contains(ip) {
      const address = normalizeAddress(ip);
      if (!address) return false;
      return list.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
    },
  };
}

const invalid = (entry: string) =>
  new InvalidTrustedProxiesError(
    `NUXT_TRUSTED_PROXIES has an invalid entry "${entry}". Use comma-separated addresses or CIDR ranges (e.g. 192.168.1.5, 172.16.0.0/12), "none", or leave it empty for the default.`,
  );

/**
 * Who a request comes from, for rate limiting. `X-Forwarded-For` is only
 * believed when the TCP peer is a trusted proxy; then the rightmost entry that
 * isn't itself a trusted hop is the client (Caddy appends its view on the
 * right, and anything further left is client-supplied). A malformed entry
 * before that point means the header can't be used: the peer is the key.
 */
export function clientKey(input: { remoteAddress: string | undefined; xForwardedFor: string | undefined; trusted: TrustedProxies }): string {
  const peer = normalizeAddress(input.remoteAddress);
  if (!peer) return 'unknown';
  if (!input.trusted.contains(peer) || !input.xForwardedFor?.trim()) return peer;

  const entries = input.xForwardedFor.split(',');
  let leftmost = peer;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = normalizeAddress(entries[i]);
    if (!entry) return peer;
    if (!input.trusted.contains(entry)) return entry;
    leftmost = entry;
  }
  return leftmost;
}

const validPort = (port: string) => /^\d{1,5}$/.test(port) && Number(port) <= 65535;
