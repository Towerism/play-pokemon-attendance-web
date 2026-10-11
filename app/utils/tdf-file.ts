import { TDF_MAX_BYTES } from '../../shared/tdf/limits';
import type { TdfCommitResult, TdfPreview } from '../../server/modules/sessions/tdf-import';

export type TdfReadResult = { ok: true; value: { filename: string; content: string } } | { ok: false; error: string };

/** Reads a `.tdf` in the browser. The server parses and validates it. */
export async function readTdfFile(file: File): Promise<TdfReadResult> {
  if (file.size > TDF_MAX_BYTES) return { ok: false, error: `${file.name} is too large (max 2 MB).` };
  if (file.size === 0) return { ok: false, error: `${file.name} is empty.` };
  return { ok: true, value: { filename: file.name, content: await file.text() } };
}

/** Guards against importing last week's file into this week's session. */
export function tdfDateWarning(tournamentDate: string | null, sessionDate: string): string | null {
  if (!tournamentDate || tournamentDate === sessionDate) return null;
  return `This tournament was held on ${tournamentDate}, but you are importing it into ${sessionDate}.`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function tdfPreviewSummary(counts: TdfPreview['counts']): string {
  const parts = [
    counts.new && `${counts.new} new`,
    counts.known && `${counts.known} known`,
    counts.regulars && plural(counts.regulars, 'regular'),
    counts.listed && `${counts.listed} already listed`,
    counts.invalid && `${plural(counts.invalid, 'invalid row')} skipped`,
    counts.duplicates && `${plural(counts.duplicates, 'duplicate')} skipped`,
  ];
  return parts.filter(Boolean).join(' · ');
}

export function tdfCommitSummary(result: TdfCommitResult): string {
  if (result.alreadyImported) return 'This file was already imported for this date.';
  const parts = [
    result.added ? `Added ${plural(result.added, 'session player')}` : 'No new session players',
    result.alreadyListed && `${result.alreadyListed} already listed`,
    result.regulars && plural(result.regulars, 'regular'),
  ];
  return parts.filter(Boolean).join(' · ');
}
