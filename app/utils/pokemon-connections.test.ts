import { describe, expect, it } from 'vitest';
import {
  type ConnectionsResponse,
  type ProfessorConnectionJson,
  excludedText,
  leagueConnection,
  professorLabel,
  professorShortLabel,
  reconnectBanner,
  startedByText,
  submitAsText,
  submittingProfessor,
} from './pokemon-connections';

const at = '2026-10-12T04:00:00.000Z';
const conn = (over: Partial<ProfessorConnectionJson> = {}): ProfessorConnectionJson => ({
  professorPlayerId: '0012345',
  professorName: 'Ash Ketchum',
  status: 'connected',
  reason: null,
  connectedAt: at,
  lastRefreshedAt: at,
  submitsForLeague: false,
  ...over,
});
const BOUND = { professorPlayerId: '0000222', activityGroupId: 'g', displayName: 'Card Shop', displayId: 'L5012', canSubmit: true };
const ash = conn();
const brock = conn({ professorPlayerId: '0000222', professorName: 'Brock Harrison', submitsForLeague: true });
const both: ConnectionsResponse = { connections: [ash, brock], league: BOUND };

describe('professorLabel', () => {
  it('names the professor with their player id', () => {
    expect(professorLabel(ash)).toBe('Ash Ketchum (0012345)');
  });

  it('falls back to "Professor <player id>" without a name, and says a carried-over connection is still being identified', () => {
    expect(professorLabel(conn({ professorName: null }))).toBe('Professor 0012345');
    expect(professorLabel(conn({ professorName: null, professorPlayerId: null }))).toBe('Identifying…');
  });
});

describe('professorShortLabel (banner, toasts)', () => {
  it('is the display name alone, or "Professor <player id>" without one', () => {
    expect(professorShortLabel(ash)).toBe('Ash Ketchum');
    expect(professorShortLabel(conn({ professorName: null }))).toBe('Professor 0012345');
    expect(professorShortLabel(conn({ professorName: null, professorPlayerId: null }))).toBe('Identifying…');
  });
});

describe('submittingProfessor', () => {
  it('is the connection that submits for the league, or none', () => {
    expect(submittingProfessor(both)).toBe(brock);
    expect(submittingProfessor({ connections: [ash], league: null })).toBeNull();
    expect(submittingProfessor(undefined)).toBeNull();
  });
});

describe('leagueConnection (what submit and staff checks read)', () => {
  it("takes the submitting professor's status and the league", () => {
    expect(leagueConnection(both)).toEqual({ status: 'connected', league: { id: 'g', name: 'Card Shop', displayId: 'L5012', canSubmit: true } });
    expect(leagueConnection({ connections: [ash, { ...brock, status: 'needs_reconnect' }], league: BOUND }).status).toBe('needs_reconnect');
  });

  it('is connected with no league while professors are connected but none submits, and not_connected with nobody', () => {
    expect(leagueConnection({ connections: [ash], league: null })).toEqual({ status: 'connected', league: null });
    expect(leagueConnection({ connections: [], league: null })).toEqual({ status: 'not_connected', league: null });
    expect(leagueConnection(null)).toEqual({ status: 'not_connected', league: null });
  });
});

describe('reconnectBanner', () => {
  it('names the submitting professor when they need a reconnect', () => {
    expect(reconnectBanner({ connections: [ash, { ...brock, status: 'needs_reconnect' }], league: BOUND })).toBe(
      'Pokémon no longer accepts Brock Harrison’s login. Reconnect before submitting attendance.',
    );
  });

  it('stays hidden when only another professor needs a reconnect, when nobody submits, or when all is well', () => {
    expect(reconnectBanner({ connections: [{ ...ash, status: 'needs_reconnect' }, brock], league: BOUND })).toBeNull();
    expect(reconnectBanner({ connections: [{ ...ash, status: 'needs_reconnect' }], league: null })).toBeNull();
    expect(reconnectBanner(both)).toBeNull();
    expect(reconnectBanner(undefined)).toBeNull();
  });
});

describe('submitAsText', () => {
  it('says who attendance goes in as', () => {
    expect(submitAsText(both)).toBe('Submitting as Brock Harrison (0000222)');
    expect(submitAsText({ connections: [ash], league: null })).toBeNull();
  });
});

describe('startedByText (History)', () => {
  it('adds the professor to who started the attempt, when it was recorded', () => {
    expect(startedByText({ startedBy: 'organizer', professor: { playerId: '0000222', name: 'Brock Harrison' } })).toBe(
      'organizer, as Brock Harrison (0000222)',
    );
    expect(startedByText({ startedBy: 'organizer', professor: { playerId: '0000222', name: null } })).toBe('organizer, as Professor 0000222');
    expect(startedByText({ startedBy: 'organizer', professor: null })).toBe('organizer');
  });

  it('says a staff or player import read as every connected professor (#75)', () => {
    expect(startedByText({ startedBy: 'organizer', professor: null, kind: 'staff_import' })).toBe('organizer, as every connected professor');
    expect(startedByText({ startedBy: 'organizer', professor: null, kind: 'player_import' })).toBe('organizer, as every connected professor');
    expect(startedByText({ startedBy: 'organizer', professor: { playerId: '0012345', name: null }, kind: 'staff_import' })).toBe(
      'organizer, as Professor 0012345',
    );
  });
});

describe('excludedText (league picker, #75)', () => {
  it('names who the shared leagues leave out until they reconnect', () => {
    expect(excludedText([])).toBeNull();
    expect(excludedText([{ playerId: '0000222', name: 'Brock Harrison' }])).toBe("Brock Harrison isn't included until reconnected.");
    expect(excludedText([{ playerId: '0000222', name: null }, { playerId: '0000333', name: 'Cilan' }])).toBe(
      "Professor 0000222 and Cilan aren't included until reconnected.",
    );
  });
});
