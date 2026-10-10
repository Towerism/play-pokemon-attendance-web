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
