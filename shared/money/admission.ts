/** The highest admission the app takes, in US cents ($999.99). */
export const MAX_ADMISSION_CENTS = 99_999;

const AMOUNT = /^\$?(\d+)(?:\.(\d{1,2}))?$/;

/**
 * A tournament's admission text as US cents: `10`, `$7.50` and `7.5` are amounts, `free` in any case is 0. Null for
 * anything else, including amounts over $999.99. Reads text from before admission was an amount, and play-tools'
 * `on_site_admission`, which is free text there.
 */
export function parseAdmission(text: string | null): number | null {
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed.toLowerCase() === 'free') return 0;
  const m = AMOUNT.exec(trimmed);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return cents <= MAX_ADMISSION_CENTS ? cents : null;
}

/** `Free` for 0, `$10` for whole dollars, `$7.50` otherwise; null for no admission. */
export function formatAdmission(cents: number | null): string | null {
  const text = admissionText(cents);
  return text === null || cents === 0 ? text : `$${text}`;
}

/**
 * The admission as play-tools' `on_site_admission` takes it: `Free`, `10` or `7.50`, as values already there read
 * (`"FREE"`, `"10"`). Null for no admission.
 */
export function admissionText(cents: number | null): string | null {
  if (cents === null) return null;
  if (cents === 0) return 'Free';
  const dollars = Math.floor(cents / 100);
  const rest = cents % 100;
  return rest === 0 ? String(dollars) : `${dollars}.${String(rest).padStart(2, '0')}`;
}
