import type { SessionDate } from '../../../shared/types/ids';
import type { PokemonConnectionService } from '../pokemon/connection';
import type { PlaySession, PlaySessionStatus, PlayToolsGateway } from '../pokemon/ports/play-tools-gateway';
import { SubmissionError } from './errors';
import { localDay } from '../../../shared/time/local-time';
import { sessionLabel } from './local-time';

export interface PlaySessionCandidate {
  id: string;
  label: string;
  status: PlaySessionStatus;
  startsAt: Date;
  endsAt: Date | null;
  editableUntil: Date | null;
  /** Attendance can still be changed upstream (before `editableUntil`). */
  editable: boolean;
}

export interface Resolution {
  /** The league timezone the date was read in. */
  timeZone: string;
  /** Sessions starting that local day, by start time. */
  candidates: PlaySessionCandidate[];
}

export interface PlaySessionResolver {
  /** The date's play sessions, read as `connectionId` (ADR-0015 §4). @throws PokemonUpstreamError, SubmissionError */
  resolve(leagueId: string, date: SessionDate, connectionId: number): Promise<Resolution>;
  /** @throws SubmissionError `unknown_play_session` when the id is not one of the date's sessions */
  find(leagueId: string, date: SessionDate, playSessionId: string, connectionId: number): Promise<PlaySessionCandidate>;
}

export interface ResolverDeps {
  connections: Pick<PokemonConnectionService, 'league'>;
  gateway: (connectionId: number) => Pick<PlayToolsGateway, 'listPlaySessions'>;
  timeZone: string;
  now?: () => Date;
}

const CACHE_MS = 5 * 60_000;

/** The league's upstream activity group, once the owner has chosen it. @throws SubmissionError `league_not_selected` */
export function leagueGroup(connections: ResolverDeps['connections'], leagueId: string): string {
  const league = connections.league(leagueId);
  if (!league) throw new SubmissionError('league_not_selected', 'Choose the league to submit to in Settings.');
  return league.id;
}

/** §4.4: a date in the league timezone → that day's upstream play sessions, cached for 5 minutes. */
export function createPlaySessionResolver(deps: ResolverDeps): PlaySessionResolver {
  const now = deps.now ?? (() => new Date());
  const cache = new Map<string, { at: number; sessions: PlaySession[] }>();

  // Keyed by league and group, not connection: play sessions belong to the league, so every member reads the same ones.
  async function sessionsOn(leagueId: string, groupId: string, date: SessionDate, connectionId: number): Promise<PlaySession[]> {
    const key = `${leagueId}|${groupId}|${date}`;
    const hit = cache.get(key);
    if (hit && now().getTime() - hit.at < CACHE_MS) return hit.sessions;
    const sessions = await deps.gateway(connectionId).listPlaySessions(groupId, localDay(date, deps.timeZone));
    cache.set(key, { at: now().getTime(), sessions });
    return sessions;
  }

  const resolver: PlaySessionResolver = {
    async resolve(leagueId, date, connectionId) {
      const groupId = leagueGroup(deps.connections, leagueId);
      const sessions = await sessionsOn(leagueId, groupId, date, connectionId);
      return {
        timeZone: deps.timeZone,
        candidates: [...sessions]
          .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
          .map((s) => ({
            id: s.id,
            label: sessionLabel(s, deps.timeZone),
            status: s.status,
            startsAt: s.startsAt,
            endsAt: s.endsAt,
            editableUntil: s.editableUntil,
            editable: !s.editableUntil || now() < s.editableUntil,
          })),
      };
    },

    async find(leagueId, date, playSessionId, connectionId) {
      const found = (await resolver.resolve(leagueId, date, connectionId)).candidates.find((c) => c.id === playSessionId);
      if (!found) throw new SubmissionError('unknown_play_session', `That play session is not one of ${date}'s sessions in play-tools.`);
      return found;
    },
  };
  return resolver;
}
