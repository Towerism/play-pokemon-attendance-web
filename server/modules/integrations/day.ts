import { INTEGRATION_STAFF_ROLES, type AttendanceDayV1, type IntegrationStaffRole } from '../../../shared/schemas/integrations';
import type { SessionDate } from '../../../shared/types/ids';
import type { ActingConnection } from '../pokemon/connection';
import type { DaySnapshot } from '../staffing/service';
import { IntegrationError } from './errors';

type DayTournament = AttendanceDayV1['tournaments'][number];
type DayProfessor = AttendanceDayV1['professors'][number];

/** A live assignment the contract can't carry: its stored role isn't one of the contract's roles. */
export interface SkippedStaff {
  tournamentId: string;
  playerId: string;
  role: string;
}

const GAMES: Record<string, DayTournament['game']> = { tcg: 'tcg', vg: 'vgc', pgo: 'go' };
const isContractRole = (role: string): role is IntegrationStaffRole => (INTEGRATION_STAFF_ROLES as readonly string[]).includes(role);

/** One game only when play-tools names exactly one product the contract knows. */
const gameOf = (products: readonly string[]) => (products.length === 1 ? (GAMES[products[0]!] ?? null) : null);

/**
 * The day as the v1 contract has it (#115). `connections` is the connection list read after the snapshot, so a
 * professor identified during the reads counts. Every one of them is listed, and is `read` only when the snapshot
 * read them in full. A connection the snapshot never read (connected meanwhile) is `unread`, never `read`.
 * @throws IntegrationError `professor_unidentified` when a connected professor still has no player id
 */
export function toAttendanceDay(input: { date: SessionDate; snapshot: DaySnapshot; connections: readonly ActingConnection[] }): {
  day: AttendanceDayV1;
  skipped: SkippedStaff[];
} {
  const { date, snapshot, connections } = input;
  if (connections.some((c) => c.professorPlayerId === null)) {
    throw new IntegrationError('professor_unidentified', 'A connected professor has no player id yet. Reconnect them in Settings, then try again.');
  }
  const displayName = (playerId: string) => {
    const c = connections.find((x) => x.professorPlayerId === playerId);
    return c?.professorName || `Professor ${playerId}`;
  };

  const skipped: SkippedStaff[] = [];
  const seen = new Set<string>();
  const tournaments: DayTournament[] = [];
  for (const { tournament: t, organizerPlayerId, staff } of snapshot.tournaments) {
    if (seen.has(t.id) || !t.startsAt) continue;
    seen.add(t.id);
    tournaments.push({
      id: t.id,
      name: t.name || t.displayId || t.id,
      displayId: t.displayId,
      startsAt: t.startsAt.toISOString(),
      game: gameOf(t.products),
      organizer: { playerId: organizerPlayerId, name: displayName(organizerPlayerId) },
      staff: staff.flatMap((s) => {
        if (isContractRole(s.role)) return [{ playerId: s.playerId, name: s.name, role: s.role }];
        skipped.push({ tournamentId: t.id, playerId: s.playerId, role: s.role });
        return [];
      }),
    });
  }
  tournaments.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const professors: DayProfessor[] = connections.map((c) => {
    const playerId = c.professorPlayerId!;
    const outcome = snapshot.professors.find((p) => p.connectionId === c.id)?.outcome;
    const base = { playerId, name: displayName(playerId) };
    if (outcome?.status === 'read') return { ...base, status: 'read' };
    return { ...base, status: 'unread', reason: outcome?.code === 'needs_reconnect' ? 'needs_reconnect' : 'read_failed' };
  });

  return { day: { date, timezone: snapshot.timeZone, tournaments, professors }, skipped };
}
