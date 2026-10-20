import type { PokemonConnectionService } from '../pokemon/connection';
import type { DateRange, PlaySession, PlaySessionStatus, PlayToolsGateway } from '../pokemon/ports/play-tools-gateway';
import { leagueGroup } from './resolve';

/** Every status a play session can have; the gateway stops at the first that matches, so each is listed on its own. */
const STATUSES: readonly PlaySessionStatus[] = ['active', 'pending', 'complete'];

export interface PlaySessionLister {
  /**
   * The league's play sessions starting in `range`, by start: one listing per status, merged by session GUID, read as
   * the reading connection (ADR-0015 §4). For the calendar feeds (ADR-0016 §5), which count the sessions as read only
   * when all three listings succeed, so any failure throws.
   * @throws SubmissionError `league_not_selected`, PokemonUpstreamError
   */
  listPlaySessionsInRange(leagueId: string, range: DateRange): Promise<PlaySession[]>;
}

export interface PlaySessionListerDeps {
  connections: Pick<PokemonConnectionService, 'league' | 'readingConnection'>;
  gateway: (connectionId: number) => Pick<PlayToolsGateway, 'listPlaySessions'>;
}

export function createPlaySessionLister(deps: PlaySessionListerDeps): PlaySessionLister {
  return {
    async listPlaySessionsInRange(leagueId, range) {
      const groupId = leagueGroup(deps.connections, leagueId);
      const gateway = deps.gateway(deps.connections.readingConnection(leagueId, null));
      const found = new Map<string, PlaySession>();
      // One call at a time, like every other read of play-tools.
      for (const status of STATUSES) {
        for (const s of await gateway.listPlaySessions(groupId, range, [status])) if (!found.has(s.id)) found.set(s.id, s);
      }
      return [...found.values()].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || (a.id < b.id ? -1 : 1));
    },
  };
}
