import { describe, expect, it } from 'vitest';
import {
  type ConnectionsResponse,
  type ProfessorConnectionJson,
  excludedText,
  historyLock,
  importsBlocked,
  onlyText,
  organizerOptions,
  professorLabel,
  professorShortLabel,
  reconnectBanner,
  refusedText,
  startedByText,
  submitAsChoice,
  waitingText,
} from './pokemon-connections';

const at = '2026-10-12T04:00:00.000Z';
const conn = (over: Partial<ProfessorConnectionJson> = {}): ProfessorConnectionJson => ({
  professorPlayerId: '0012345',
  professorName: 'Ash Ketchum',
  professorFullName: null,
  status: 'connected',
  reason: null,
  connectedAt: at,
  lastRefreshedAt: at,
  mine: true,
  membership: 'member',
  canSubmit: true,
  ...over,
});
const LEAGUE = { activityGroupId: 'g', displayName: 'Card Shop', displayId: 'L5012' };
const ash = conn();
const brock = conn({ professorPlayerId: '0000222', professorName: 'Brock Harrison' });
const misty = conn({ professorPlayerId: '0000333', professorName: 'Misty', mine: false });
const of = (...connections: ProfessorConnectionJson[]): ConnectionsResponse => ({ connections, league: LEAGUE });

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

describe('submitAsChoice (the submit dialog, ADR-0015 §4)', () => {
  it("names the viewer's one connection that can submit", () => {
    expect(submitAsChoice(of(ash, misty))).toEqual({ kind: 'one', playerId: '0012345', text: 'Submitting as Ash Ketchum (0012345)' });
  });

  it('asks which when the viewer has several, offering only theirs that can', () => {
    expect(submitAsChoice(of(ash, brock, conn({ professorPlayerId: '0000444', canSubmit: false }), misty))).toEqual({
      kind: 'several',
      options: [
        { value: '0012345', label: 'Ash Ketchum (0012345)' },
        { value: '0000222', label: 'Brock Harrison (0000222)' },
      ],
    });
  });

  it("says none can, naming the league, when none of the viewer's connections may record attendance", () => {
    expect(submitAsChoice(of(conn({ canSubmit: false }), misty))).toEqual({
      kind: 'none',
      text: 'None of your Pokémon accounts can record attendance for Card Shop.',
    });
    expect(submitAsChoice(of(conn({ status: 'needs_reconnect' })))).toMatchObject({ kind: 'none' });
    expect(submitAsChoice(null)).toMatchObject({ kind: 'none', text: 'None of your Pokémon accounts can record attendance for the league.' });
  });
});

describe('reconnectBanner (the layout)', () => {
  it("names the viewer's own connection that needs a reconnect, and nobody else's", () => {
    expect(reconnectBanner(of(ash, conn({ ...misty, status: 'needs_reconnect' })))).toBeNull();
    expect(reconnectBanner(of(conn({ status: 'needs_reconnect' })))).toBe('Pokémon no longer accepts Ash Ketchum’s login. Reconnect it in Settings.');
  });
});

describe('onlyText (read-only actions, ADR-0015 §4)', () => {
  it("says who alone may change it when another user holds the organizer's connection", () => {
    expect(onlyText(of(ash, misty), '0000333')).toBe('Only Misty (0000333) can change this');
  });

  it("is null for the viewer's own connection, and for an organizer nobody has connected (the old notices apply)", () => {
    expect(onlyText(of(ash, misty), '0012345')).toBeNull();
    expect(onlyText(of(ash), '0000999')).toBeNull();
    expect(onlyText(of(ash), null)).toBeNull();
  });
});

describe("organizerOptions (the template form's organizer)", () => {
  it("offers the viewer's own connections, and shows another's current organizer without letting it be picked", () => {
    expect(organizerOptions(of(ash, misty), null)).toEqual([{ value: '0012345', label: 'Ash Ketchum (0012345)', disabled: false }]);
    expect(organizerOptions(of(ash, misty), '0000333')).toEqual([
      { value: '0012345', label: 'Ash Ketchum (0012345)', disabled: false },
      { value: '0000333', label: 'Misty (0000333)', disabled: true, description: 'Only Misty can choose this' },
    ]);
  });

  it('marks one of the viewer’s that needs a reconnect, and lets nobody pick it: the form reads play-tools as it', () => {
    expect(organizerOptions(of(conn({ status: 'needs_reconnect' })), null)).toEqual([
      { value: '0012345', label: 'Ash Ketchum (0012345)', disabled: true, description: 'Reconnect in Settings' },
    ]);
  });
});

describe('refusedText (a create across organizers)', () => {
  it('names each tournament left out and who alone may create it', () => {
    expect(refusedText(of(ash, misty), [], () => '')).toBeNull();
    expect(refusedText(of(ash, misty), [{ plannedTournamentId: 7, professorPlayerId: '0000333' }], () => 'Friday Cup · 2026-11-06')).toBe(
      'Left out: only Misty (0000333) can create Friday Cup · 2026-11-06.',
    );
  });
});

describe('waitingText (Settings for a professor not yet in the league)', () => {
  it('says why the professor sees only Settings', () => {
    expect(waitingText('no_connection', null)).toBe('Connect your Pokémon account to use the league.');
    expect(waitingText('outside', 'Card Shop')).toBe("Your Pokémon account isn't in Card Shop in play-tools.");
    expect(waitingText('outside', null)).toBe("Your Pokémon account isn't in the league in play-tools.");
    expect(waitingText('unknown', 'Card Shop')).toBe('Checking your Pokémon account’s league…');
    expect(waitingText(null, null)).toBeNull();
  });

  it('asks a professor who accepted a reset link to log in to Pokémon as their own account again', () => {
    expect(waitingText('reverify_required', 'Card Shop', 'Misty (0000333)')).toBe("Log in to Pokémon as Misty (0000333) to confirm it's you.");
    expect(waitingText('reverify_required', 'Card Shop', null)).toBe('Connect your Pokémon account to use the league.');
  });
});

describe('importsBlocked (staff and player imports)', () => {
  it('needs a connection that can be read and the league chosen', () => {
    expect(importsBlocked({ connections: [], league: LEAGUE })).toBe('Connect a Pokémon account first.');
    expect(importsBlocked(of(conn({ status: 'needs_reconnect' })))).toBe('Reconnect the Pokémon account first.');
    expect(importsBlocked({ connections: [ash], league: null })).toBe('Choose the league first.');
    expect(importsBlocked(of(ash))).toBeNull();
  });
});


describe("historyLock (who may retry or undo, ADR-0015 §4)", () => {
  const run = (over: Partial<{ kind: string; professor: { playerId: string; name: string | null } | null }> = {}) => ({
    kind: 'submit',
    professor: { playerId: '0012345', name: 'Ash Ketchum' },
    ...over,
  });

  it("is null for an attempt that ran as the viewer's own connection", () => {
    expect(historyLock(of(ash, misty), run(), 'professor')).toBeNull();
  });

  it("says who alone may redo an attempt that ran as another user's connection", () => {
    expect(historyLock(of(ash, misty), run({ professor: { playerId: '0000333', name: 'Misty' } }), 'owner')).toBe('Only Misty (0000333) can change this');
  });

  it('says nobody can redo an attempt from before professors were recorded', () => {
    expect(historyLock(of(ash), run({ professor: null }), 'owner')).toBe('No professor was recorded for this attempt, so it can’t be retried or undone.');
  });

  it("keeps imports the owner's", () => {
    expect(historyLock(of(ash), run({ kind: 'staff_import', professor: null }), 'owner')).toBeNull();
    expect(historyLock(of(ash), run({ kind: 'player_import', professor: null }), 'professor')).toBe('Only the owner can run an import.');
  });
});
