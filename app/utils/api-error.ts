interface FetchErrorLike {
  statusCode?: number;
  data?: { statusMessage?: string; message?: string; data?: { code?: unknown } };
}

/** The machine-readable `data.code` a route attached to its error (e.g. `needs_reconnect`), if any. */
export function apiErrorCode(err: unknown): string | undefined {
  const code = (err as FetchErrorLike | undefined)?.data?.data?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * A message to show for a failed `$fetch`. Validation errors (400) carry the
 * Zod issue list as JSON in `message`; show the first issue's text.
 */
export function apiErrorMessage(err: unknown, fallback = 'Something went wrong. Try again.'): string {
  const data = (err as FetchErrorLike | undefined)?.data;
  const message = data?.message;
  if (!message) return fallback;
  if (data.statusMessage === 'Validation Error') {
    try {
      const issues = JSON.parse(message) as { message?: string }[];
      if (issues[0]?.message) return issues[0].message;
    } catch {
      // not an issue list: show it as is
    }
  }
  return message;
}
