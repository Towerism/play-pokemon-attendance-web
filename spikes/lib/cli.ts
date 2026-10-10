import { type Interface, createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';

export { sleep };

// One line iterator per process. `rl.question()` drops lines that arrive
// before it is called (e.g. a fast multi-line paste); the iterator buffers them.
let rl: Interface | undefined;
let lines: AsyncIterator<string> | undefined;

export async function prompt(question: string): Promise<string> {
  rl ??= createInterface({ input: process.stdin, terminal: false });
  lines ??= rl[Symbol.asyncIterator]();
  process.stdout.write(question);
  const next = await lines.next();
  if (next.done) fail('No input.');
  return next.value.trim();
}

export async function confirm(question: string): Promise<boolean> {
  return /^y(es)?$/i.test(await prompt(`${question} [y/N] `));
}

export function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

export function heading(text: string): void {
  console.log(`\n=== ${text} ===`);
}

/** Runs `main`, printing errors without stack noise for expected failures. */
export function run(main: () => Promise<void>): void {
  main()
    .catch((err: unknown) => {
      console.error(err instanceof Error ? (err.stack ?? err.message) : err);
      process.exitCode = 1;
    })
    .finally(() => rl?.close());
}
