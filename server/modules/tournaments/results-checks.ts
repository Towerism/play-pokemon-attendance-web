import type { FingerprintedWarning } from '../../../shared/tdf/fingerprint';
import type { ParsedTdf } from '../../../shared/tdf/parse';
import type { TournamentDetails, TournamentParticipant } from '../pokemon/ports/play-tools-gateway';

/**
 * The results upload's local checks (ADR-0011 decision 3 and Update #96): pure, so the preview, a recheck
 * and the `tdf_upload` job's check just before the send all work them out the same way.
 */

export type Uploadability =
  | { ok: true }
  | { ok: false; code: 'results_already_uploaded'; reason: null }
  | { ok: false; code: 'results_not_accepted'; reason: 'not_sanctioned' | 'window_closed' };

/** Activity states after which play-tools holds results for the tournament. */
const UPLOADED: ReadonlySet<string> = new Set(['upload_in_progress', 'completed']);

/**
 * Whether play-tools takes an organizer's upload for the tournament now (S8, ADR-0011 Update #96): sanctioned, not complete,
 * no results being processed or held, within start + 90 days, and no player records yet. A failed processing blocks
 * nothing.
 */
export function uploadability(
  read: Pick<TournamentDetails, 'applicationState' | 'status' | 'activityState' | 'editableUntil'>,
  participants: readonly TournamentParticipant[],
  now: Date,
): Uploadability {
  if (read.status === 'complete' || UPLOADED.has(read.activityState ?? 'pending') || participants.some((p) => !p.isStaff)) {
    return { ok: false, code: 'results_already_uploaded', reason: null };
  }
  if ((read.applicationState ?? read.status) !== 'sanctioned') return { ok: false, code: 'results_not_accepted', reason: 'not_sanctioned' };
  if (read.editableUntil !== null && now >= read.editableUntil) return { ok: false, code: 'results_not_accepted', reason: 'window_closed' };
  return { ok: true };
}

/** What the app changed in the file, as recorded on the upload (ADR-0011 decision 8). */
export interface ResultsCorrections {
  organizerReplaced: { fromPlayerId: string; fromName: string; toPlayerId: string; toName: string } | null;
  tournamentIdFilled: boolean;
}

export type ResultsWarning =
  | { code: 'tdf_organizer_replaced'; message: string; from: { playerId: string; name: string }; to: { playerId: string; name: string } }
  | { code: 'tdf_wrong_organizer'; message: string; filePlayerId: string | null }
  | { code: 'tdf_tournament_id_filled'; message: string; displayId: string }
  | { code: 'tdf_wrong_tournament'; message: string; fileTournamentId: string | null }
  | { code: 'tdf_wrong_game'; message: string; fileProduct: string }
  | { code: 'tdf_staff_also_playing'; message: string; player: { playerId: string; name: string; role: string; removable: boolean } }
  | { code: 'tdf_unknown_players'; message: string; players: { playerId: string; name: string; knownAs: string | null }[] };

export interface ResultsCheckInput {
  /** The file as it will be sent: the corrected copy when the app corrected it. */
  parsed: ParsedTdf;
  tournament: { displayId: string | null; organizerPlayerId: string; products: readonly string[]; name?: string | null; date?: string | null };
  participants: readonly TournamentParticipant[];
  /** Player ids the league has a `PLAYER` row for. */
  knownPlayerIds: ReadonlySet<string>;
  /** `normalName(name)` → the ids of league players with that name, ascending. */
  knownNames: ReadonlyMap<string, readonly string[]>;
  corrections: ResultsCorrections;
}

/** A name compared ignoring case and spacing. */
export function normalName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().toLowerCase();
}

const PRODUCT_LABEL: Record<string, string> = { tcg: 'TCG', vg: 'VGC', pgo: 'Pokémon GO' };
const label = (product: string) => PRODUCT_LABEL[product] ?? product;

/**
 * The warnings of ADR-0011 Update #96, in a fixed order: corrections first, then mismatches, staff who played, and players
 * new to the app. Recorded corrections are carried even though the corrected file no longer shows them (ADR-0011 Update #96).
 */
export function resultsWarnings(input: ResultsCheckInput): ResultsWarning[] {
  const { parsed, tournament, corrections } = input;
  const warnings: ResultsWarning[] = [];
  const replaced = corrections.organizerReplaced;
  if (replaced) {
    warnings.push({
      code: 'tdf_organizer_replaced',
      message: `The file names ${replaced.fromPlayerId} (${replaced.fromName}) as organizer. It will be sent with ${replaced.toName} (${replaced.toPlayerId}), the tournament's organizer, instead.`,
      from: { playerId: replaced.fromPlayerId, name: replaced.fromName },
      to: { playerId: replaced.toPlayerId, name: replaced.toName },
    });
  }
  const fileOrganizer = parsed.header.organizer?.playerId ?? null;
  if (fileOrganizer !== tournament.organizerPlayerId) {
    warnings.push({
      code: 'tdf_wrong_organizer',
      message: `${fileOrganizer ? `The file names ${fileOrganizer} as organizer` : 'The file names no organizer'}, not the tournament's organizer ${tournament.organizerPlayerId}, and the app can't fix it. play-tools will likely refuse it (ORGANIZER_ID_MISMATCH).`,
      filePlayerId: fileOrganizer,
    });
  }

  const fileId = parsed.header.tournamentId;
  if (corrections.tournamentIdFilled && fileId) {
    const on = [tournament.name, tournament.date].filter(Boolean);
    warnings.push({
      code: 'tdf_tournament_id_filled',
      message: `The TDF's tournament id is empty. It will be sent with this tournament's id, ${fileId}.${on.length === 2 ? ` Check that this file is for ${on[0]} on ${on[1]}.` : ' Check that this file is for this tournament.'}`,
      displayId: fileId,
    });
  }
  if (fileId !== tournament.displayId) {
    warnings.push({
      code: 'tdf_wrong_tournament',
      message: fileId
        ? `The file is for tournament ${fileId}, not this tournament's ${tournament.displayId ?? '(no id)'}. play-tools will likely refuse it.`
        : "The file has no tournament id, and the app couldn't fill it in. play-tools will likely refuse it.",
      fileTournamentId: fileId,
    });
  }

  const product = parsed.header.game.product;
  if (product && !tournament.products.includes(product)) {
    warnings.push({
      code: 'tdf_wrong_game',
      message: `The file is a ${label(product)} file, but this tournament is ${tournament.products.map(label).join(', ') || 'another game'}. play-tools will likely refuse it.`,
      fileProduct: product,
    });
  }

  const staff = new Map(input.participants.filter((p) => p.isStaff && p.role).map((p) => [p.playerId as string, p]));
  for (const player of parsed.players) {
    const record = staff.get(player.playerId);
    if (!record) continue;
    const name = player.name || record.name;
    warnings.push({
      code: 'tdf_staff_also_playing',
      message: `${name || player.playerId} (${player.playerId}) is in the file as a player and on the tournament's staff as ${record.role}. play-tools refuses this (STAFF_PLAYERS_ERROR).`,
      player: { playerId: player.playerId, name, role: record.role!, removable: record.role !== 'organizer' },
    });
  }

  const unknown = parsed.players.filter((p) => !input.knownPlayerIds.has(p.playerId));
  if (unknown.length > 0) {
    warnings.push({
      code: 'tdf_unknown_players',
      message: "Not in the app yet. Check these ids weren't mis-keyed in TOM.",
      players: unknown.map((p) => ({ playerId: p.playerId, name: p.name, knownAs: input.knownNames.get(normalName(p.name))?.[0] ?? null })),
    });
  }
  return warnings;
}

/** What a warning is about, for the fingerprint (ADR-0011 Update #96): ids and roles, never names or messages. */
export function warningSubjects(w: ResultsWarning): string[] {
  switch (w.code) {
    case 'tdf_organizer_replaced':
      return [w.from.playerId, w.to.playerId];
    case 'tdf_wrong_organizer':
      return [w.filePlayerId ?? 'none'];
    case 'tdf_tournament_id_filled':
      return [w.displayId];
    case 'tdf_wrong_tournament':
      return [w.fileTournamentId ?? 'none'];
    case 'tdf_wrong_game':
      return [w.fileProduct];
    case 'tdf_staff_also_playing':
      return [w.player.playerId, w.player.role];
    case 'tdf_unknown_players':
      return w.players.map((p) => p.playerId);
  }
}

/** The warnings as the fingerprint takes them. */
export const fingerprinted = (warnings: readonly ResultsWarning[]): FingerprintedWarning[] =>
  warnings.map((w) => ({ code: w.code, subjects: warningSubjects(w) }));
