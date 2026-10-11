import { describe, expect, it } from 'vitest';
import { createLogger } from './logger';

// 50 keys, 5 of them secret, nested two levels down.
function record(i: number): Record<string, unknown> {
  const inner: Record<string, unknown> = {};
  for (let k = 0; k < 45; k++) inner[`field${k}`] = `value-${i}-${k}`;
  Object.assign(inner, { token: 't', password: 'p', cookie: 'c', refresh_token: 'r', dob: 'd' });
  return { outer: { inner } };
}

function timeTenThousand(format: 'json' | 'pretty'): number {
  let bytes = 0;
  const log = createLogger({ scope: 'bench', level: 'info', format, destination: { write: (l) => (bytes += l.length) } });
  const start = performance.now();
  for (let i = 0; i < 10_000; i++) log.info('record', record(i));
  const elapsed = performance.now() - start;
  expect(bytes).toBeGreaterThan(0);
  return elapsed;
}

describe('logger throughput', () => {
  it('redacts and writes 10,000 nested records in under a second as JSON', () => {
    expect(timeTenThousand('json')).toBeLessThan(1_000);
  });

  it('redacts and writes 10,000 nested records in under 2.5 seconds as readable lines', () => {
    expect(timeTenThousand('pretty')).toBeLessThan(2_500);
  });
});
