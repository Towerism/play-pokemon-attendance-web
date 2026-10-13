import type { StaffRole } from '../../ports/play-tools-gateway';

/** Organized Play gateway (architecture §4.3). */
export const OP_API_BASE = 'https://api.play.pokemon.com/services/';

/**
 * Headers sent on every OP API call. The predecessor CLI replayed a full
 * Chrome header set; spike S3 checks whether this minimal, honest set is
 * accepted (Referer/Origin match what the play-tools SPA sends).
 */
export const OP_API_HEADERS = {
  accept: 'application/json',
  origin: 'https://play-tools.pokemon.com',
  referer: 'https://play-tools.pokemon.com/',
} as const;

export const opPaths = {
  userActivityGroups: (userId: string) => `core/users/${enc(userId)}/activity_groups/`,
  playSessions: (groupId: string) => `core/activity_groups/${enc(groupId)}/play_sessions/`,
  records: (groupId: string, sessionId: string) =>
    `core/activity_groups/${enc(groupId)}/play_sessions/${enc(sessionId)}/records/`,
  recordsBulk: (groupId: string, sessionId: string) =>
    `core/activity_groups/${enc(groupId)}/play_sessions/${enc(sessionId)}/records/_bulk/`,
  record: (groupId: string, sessionId: string, recordId: string) =>
    `core/activity_groups/${enc(groupId)}/play_sessions/${enc(sessionId)}/records/${enc(recordId)}/`,
} as const;

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

/** Tournament paths (S6): recorded without a trailing slash, which upstream accepts. */
export const tournamentPaths = {
  activities: () => 'core/activities',
  details: (tournamentId: string) => `core/tournament/${enc(tournamentId)}`,
  records: (tournamentId: string) => `core/tournaments/${enc(tournamentId)}/records`,
  record: (tournamentId: string, recordId: string) => `core/tournaments/${enc(tournamentId)}/records/${enc(recordId)}`,
} as const;

/** Tournament lifecycle and TDF paths (S8 part 2), exactly as recorded, trailing slashes included. */
export const lifecyclePaths = {
  create: () => 'core/tournament',
  edit: (tournamentId: string) => `core/tournament/${enc(tournamentId)}/`,
  series: (userId: string, groupId: string) => `core/users/${enc(userId)}/activity_groups/${enc(groupId)}/series/`,
  products: () => 'core/products',
  addressBook: (userGuid: string) => `core/v2/users/${enc(userGuid)}/address_book`,
  validate: () => 'triumph/tdf/',
  confirm: (uploadId: string) => `triumph/${enc(uploadId)}/confirm/`,
  uploads: (displayId: string) => `triumph/tournament/${enc(displayId)}/uploads/`,
} as const;

/**
 * Readable text for the TDF errors play-tools' UI explains (S8 part 1), plus the two "file doesn't match" codes S8
 * recorded or named. Any other code is shown as play-tools sent it.
 */
export const TDF_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  TDF_TOURNAMENT_ID_AND_PAYLOAD_ID_MISMATCH_ERROR: "The file's tournament id isn't this tournament's.",
  ORGANIZER_ID_MISMATCH: "The file's organizer isn't this tournament's organizer.",
  GAMETYPE_PRODUCT_CODE_ERROR: "The file's game isn't this tournament's game.",
  PLAYER_IDS_CHECK_ERROR: "play-tools couldn't check the file's player ids.",
  INVALID_PLAYER_IDS_ERROR: 'The file has player ids play-tools doesn\'t know.',
  STAFF_PLAYERS_ERROR: 'Someone in the file is on the tournament staff.',
  MERGED_PLAYER_IDS_ERROR: 'The file has a player id that was merged into another one.',
  DUPLICATE_PLAYER_IDS_ERROR: 'The file lists a player id more than once.',
  PLAYER_COUNT_MISMATCH_ERROR: "The file's player count doesn't match its players.",
  MISSING_PLAYERS_FROM_STANDINGS_ERROR: "Some players in the file aren't in its standings.",
  MISSING_PLAYERS_FROM_ROSTER_ERROR: "Some players in the standings aren't in the file's roster.",
  MISSING_STANDINGS_ERROR: 'The file has no standings.',
});

/**
 * `activity_division_info` on create: one empty entry per division, as the organizer's own tournaments carry it.
 * `null` is refused upstream (S8 recording 15), and per-division times and costs are out of scope (ADR-0010).
 */
export const EMPTY_DIVISION_INFO = Object.freeze({ juniors: null, masters: null, seniors: null, all: null });

/**
 * Staff roles (S6): a constant in play-tools' own code, not an endpoint, in its order.
 * `organizer` is fixed upstream and never offered.
 */
export const STAFF_ROLES: readonly StaffRole[] = Object.freeze([
  { code: 'judge', label: 'Judge' },
  { code: 'headjudge', label: 'Head Judge' },
  { code: 'scorekeeper', label: 'Scorekeeper' },
  { code: 'administration', label: 'Support Staff' },
  { code: 'translator', label: 'Translator' },
]);
