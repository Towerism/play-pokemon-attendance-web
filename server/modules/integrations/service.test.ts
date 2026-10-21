import { describe, expect, it, vi } from 'vitest';
import type { SessionDate } from '../../../shared/types/ids';
import { silentLogger } from '@towerism/selfhost-kit';
import { HELD_BY_OWNER, stubConnections } from '../pokemon/test-connections';
import type { ActingConnection } from '../pokemon/connection';
import { createIntegrationDayService } from './service';

const DATE = '2026-10-14' as SessionDate;
const OUTSIDE: ActingConnection = { id: 1, professorPlayerId: '9999991', professorName: 'Olive', status: 'connected', ...HELD_BY_OWNER, membership: 'outside', canSubmit: false };

describe('the integrations day', () => {
  it('answers an empty day, reading nobody, when every connection is outside the league', async () => {
    const daySnapshot = vi.fn();
    const service = createIntegrationDayService({
      staffing: { daySnapshot },
      connections: stubConnections({ professors: () => [OUTSIDE], league: () => ({ id: 'group-1', name: 'Card Shop', displayId: null }) }),
      tournaments: { admissionsFor: () => new Map() },
      timeZone: 'America/Chicago',
      log: silentLogger,
    });

    expect(await service.day('default', DATE)).toEqual({ date: DATE, timezone: 'America/Chicago', tournaments: [], professors: [] });
    expect(daySnapshot).not.toHaveBeenCalled();
  });

  it("asks the tournaments module for the league's admissions of the tournaments it read", async () => {
    const OLIVE: ActingConnection = { ...OUTSIDE, membership: 'member', canSubmit: true };
    const tournament = { id: 'g1', name: 'Olive Cup', displayId: null, groupId: 'group-1', products: ['tcg'], startsAt: new Date('2026-10-14T23:00:00Z'), status: 'sanctioned', editableUntil: null };
    const daySnapshot = vi.fn().mockResolvedValue({
      timeZone: 'America/Chicago',
      tournaments: [{ tournament, organizerPlayerId: '9999991', staff: [] }],
      professors: [{ connectionId: 1, outcome: { status: 'read' } }],
    });
    const admissionsFor = vi.fn().mockReturnValue(new Map([['g1', 1000]]));
    const service = createIntegrationDayService({
      staffing: { daySnapshot },
      connections: stubConnections({ professors: () => [OLIVE], league: () => ({ id: 'group-1', name: 'Card Shop', displayId: null }) }),
      tournaments: { admissionsFor },
      timeZone: 'America/Chicago',
      log: silentLogger,
    });

    const day = await service.day('default', DATE);

    expect(admissionsFor).toHaveBeenCalledWith('default', ['g1']);
    expect(day.tournaments[0]!.admissionCents).toBe(1000);
  });
});
