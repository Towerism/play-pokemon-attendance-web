/** 2,000 players of `{ name, player_id }` fit in well under this. */
export const REGULARS_FILE_MAX_BYTES = 1024 * 1024;

export type ReadResult = { ok: true; value: unknown } | { ok: false; error: string };

/** Reads the CLI's `regulars.json` in the browser. The server validates the contents. */
export async function readRegularsFile(file: File): Promise<ReadResult> {
  if (file.size > REGULARS_FILE_MAX_BYTES) return { ok: false, error: `${file.name} is too large (max 1 MB).` };
  try {
    return { ok: true, value: JSON.parse(await file.text()) };
  } catch {
    return { ok: false, error: `${file.name} is not a JSON file.` };
  }
}
