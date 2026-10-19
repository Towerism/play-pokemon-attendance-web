import { describe, expect, it, vi } from 'vitest';
import type { SessionDate } from '../../../shared/types/ids';
import { silentLogger } from '@towerism/selfhost-kit';
import { HELD_BY_OWNER, stubConnections } from '../pokemon/test-helpers';
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
      timeZone: 'America/Chicago',
      log: silentLogger,
    });

    expect(await service.day('default', DATE)).toEqual({ date: DATE, timezone: 'America/Chicago', tournaments: [], professors: [] });
    expect(daySnapshot).not.toHaveBeenCalled();
  });
});
