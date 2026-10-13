import { describe, expect, it } from 'vitest';
import { createLogger } from './logger';

// The logger is timed against plain JSON.stringify of the same records,
// measured in the same process at the same moment, so the limits hold on a
// slow or contended CI runner without asserting wall-clock milliseconds.
const RECORDS = 10_000;
const RUNS = 3;

// 50 keys, 5 of them secret, nested two levels down.
function record(i: number): Record<string, unknown> {
  const inner: Record<string, unknown> = {};
  for (let k = 0; k < 45; k++) inner[`field${k}`] = `value-${i}-${k}`;
  Object.assign(inner, { token: 't', password: 'p', cookie: 'c', refresh_token: 'r', dob: 'd' });
  return { outer: { inner } };
}

function timeBaseline(): number {
  let bytes = 0;
  const start = performance.now();
  for (let i = 0; i < RECORDS; i++) {
    bytes += JSON.stringify({ level: 30, time: Date.now(), msg: 'record', ...record(i) }).length;
  }
  const elapsed = performance.now() - start;
  expect(bytes).toBeGreaterThan(0);
  return elapsed;
}

function timeLogger(format: 'json' | 'pretty'): number {
  let bytes = 0;
  const log = createLogger({ scope: 'bench', level: 'info', format, destination: { write: (l) => (bytes += l.length) } });
  const start = performance.now();
  for (let i = 0; i < RECORDS; i++) log.info('record', record(i));
  const elapsed = performance.now() - start;
  expect(bytes, 'the logger wrote nothing').toBeGreaterThan(0);
  return elapsed;
}

// Warm both paths up, then take the best of interleaved runs so a burst of
// runner contention or a GC pause hits one run of each side, not the result.
function loggerOverBaseline(format: 'json' | 'pretty') {
  timeBaseline();
  timeLogger(format);
  let baselineMs = Infinity;
  let loggerMs = Infinity;
  for (let r = 0; r < RUNS; r++) {
    baselineMs = Math.min(baselineMs, timeBaseline());
    loggerMs = Math.min(loggerMs, timeLogger(format));
  }
  expect(baselineMs, 'the baseline measured 0 ms').toBeGreaterThan(0);
  return { baselineMs, loggerMs, ratio: loggerMs / baselineMs };
}

function describeTiming({ baselineMs, loggerMs, ratio }: ReturnType<typeof loggerOverBaseline>): string {
  return `logger ${loggerMs.toFixed(0)} ms vs JSON.stringify ${baselineMs.toFixed(0)} ms (${ratio.toFixed(1)}x)`;
}

describe('logger throughput', () => {
  it('redacts and writes 10,000 nested records as JSON within 8x plain JSON.stringify', { timeout: 30_000 }, () => {
    const timing = loggerOverBaseline('json');
    expect(timing.ratio, describeTiming(timing)).toBeLessThanOrEqual(8);
  });

  it('redacts and writes 10,000 nested records as readable lines within 12x plain JSON.stringify', { timeout: 30_000 }, () => {
    const timing = loggerOverBaseline('pretty');
    expect(timing.ratio, describeTiming(timing)).toBeLessThanOrEqual(12);
  });
});
