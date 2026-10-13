import type { PlaySession } from '../pokemon/ports/play-tools-gateway';

const PRODUCTS: Record<string, string> = { tcg: 'TCG', vg: 'VG', pgo: 'GO' };

/** e.g. "Open play · TCG, VG · Tue 6:00 PM"; upstream sessions have no title (S3). */
export function sessionLabel(session: Pick<PlaySession, 'type' | 'products' | 'startsAt'>, timeZone: string): string {
  const type = session.type.replaceAll('_', ' ');
  const products = session.products.map((p) => PRODUCTS[p] ?? p.toUpperCase()).join(', ');
  const start = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', minute: '2-digit' })
    .format(session.startsAt)
    .replace(/\s/gu, ' '); // some ICU versions put a narrow no-break space before AM/PM
  return [type.charAt(0).toUpperCase() + type.slice(1), products, start].filter(Boolean).join(' · ');
}
