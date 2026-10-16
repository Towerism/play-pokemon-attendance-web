export interface WaitOptions {
  /** Ignore output before this offset, an earlier `text().length`. */
  from?: number;
  /** How long to wait before rejecting. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/** How the process ended: what `ChildProcess` reports on `close`. */
export interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface Waiter {
  /** As the caller wrote it, for messages. */
  pattern: RegExp;
  /** Without `g` and `y`, so `match` returns the first match with its groups and ignores `lastIndex`. */
  first: RegExp;
  from: number;
  resolve: (match: RegExpMatchArray) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * A child process's output, with waits for a line to appear in it. A server's log reaches a test
 * through its pipes, a separate channel from its HTTP responses, so a line can arrive after the
 * response that caused it: wait for it rather than reading the output once.
 */
export class LogBuffer {
  #output = '';
  #waiters = new Set<Waiter>();
  #exit: Exit | undefined;

  append(chunk: string): void {
    this.#output += chunk;
    for (const waiter of this.#waiters) {
      const match = this.#find(waiter);
      if (match) this.#settle(waiter, match);
    }
  }

  /** The process has exited and its pipes are drained: no line can arrive any more. */
  close(exit: Exit): void {
    this.#exit = exit;
    for (const waiter of this.#waiters) this.#settle(waiter, this.#exited(waiter.pattern));
  }

  text(): string {
    return this.#output;
  }

  waitFor(pattern: RegExp, opts: WaitOptions = {}): Promise<RegExpMatchArray> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const first = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
      const waiter: Waiter = { pattern, first, from: opts.from ?? 0, resolve, reject };
      const match = this.#find(waiter);
      if (match) return resolve(match);
      if (this.#exit) return reject(this.#exited(pattern));
      waiter.timer = setTimeout(
        () => this.#settle(waiter, new Error(`timed out after ${timeoutMs}ms waiting for ${pattern} in logs:\n${this.#output}`)),
        timeoutMs,
      );
      this.#waiters.add(waiter);
    });
  }

  #settle(waiter: Waiter, outcome: RegExpMatchArray | Error): void {
    this.#waiters.delete(waiter);
    clearTimeout(waiter.timer);
    if (outcome instanceof Error) waiter.reject(outcome);
    else waiter.resolve(outcome);
  }

  #exited(pattern: RegExp): Error {
    const how = this.#exit!.signal ? `signal ${this.#exit!.signal}` : `code ${this.#exit!.code}`;
    return new Error(`server exited (${how}) before ${pattern} appeared in logs:\n${this.#output}`);
  }

  /** Searches only complete lines (up to the last newline), so a line still arriving never matches. */
  #find({ first, from }: Waiter): RegExpMatchArray | null {
    return this.#output.slice(from, this.#output.lastIndexOf('\n') + 1).match(first);
  }
}
