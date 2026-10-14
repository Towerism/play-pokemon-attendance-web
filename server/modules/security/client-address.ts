// Shim (kit ADR-0007, A1): client address and trusted proxies now come from @towerism/selfhost-kit.
export {
  DEFAULT_TRUSTED_PROXIES,
  InvalidTrustedProxiesError,
  type TrustedProxies,
  clientKey,
  normalizeAddress,
  parseTrustedProxies,
} from '@towerism/selfhost-kit';
