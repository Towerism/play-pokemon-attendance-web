import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('shared/zod', () => {
  it('builds and runs object schemas without ever calling Function (a CSP violation in the browser)', async () => {
    const probe = vi.fn(() => {
      throw new EvalError('Refused to evaluate a string as JavaScript');
    });
    vi.stubGlobal('Function', probe);

    const { z } = await import('./zod');
    const schema = z.object({ username: z.string().min(1), password: z.string().min(8) });

    expect(schema.safeParse({ username: 'organizer', password: 'correct horse' }).success).toBe(true);
    expect(schema.safeParse({ username: '', password: 'x' }).success).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it('is jitless before any schema module can build a schema', async () => {
    const { z } = await import('./zod');
    expect(z.config().jitless).toBe(true);
  });
});
