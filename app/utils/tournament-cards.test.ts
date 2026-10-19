import { describe, expect, it } from 'vitest';
import type { TournamentStaffView } from '../../server/modules/staffing/service';
import type { PlayerId } from '../../shared/types/ids';
import type { UpcomingEntry } from '../../server/modules/tournaments/service';
import type { ResultsSection, ResultsUploadView, ResultsWarning } from '../../server/modules/tournaments/results';
import type { SubmissionView, TournamentItemOutcome } from '../../server/modules/submission/service';
import { cardEditable, notRemovableLines, orderedWarnings, resultsView, staleWarnings, tournamentCards, uploadAgainOffered, uploadButtonLabel } from './tournament-cards';

// This week's tournament cards (#99): which card each play-tools tournament and planned row gets, and what each card
// offers. Pure, so the components only bind it.

const GUID_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const GUID_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const OLIVE = '9999991' as PlayerId;

function staffTournament(overrides: Partial<TournamentStaffView> = {}): TournamentStaffView {
  return {
    tournamentId: GUID_A,
    label: 'Friday Cup',
    startsAt: '2026-10-30T23:00:00.000Z',
    editable: true,
    organizer: { playerId: OLIVE, name: 'Olive', connected: true, needsReconnect: false },
    assignments: [],
    upstreamOnly: [],
    players: [],
    ...overrides,
  };
}

let nextPlanned = 1;
function entry(overrides: Partial<UpcomingEntry> = {}): UpcomingEntry {
  return {
    plannedId: nextPlanned++,
    tournamentId: null,
    scheduleId: null,
    slotPosition: null,
    occurrenceDate: null,
    templateId: 1,
    name: 'Friday Cup',
    localDate: '2026-10-30',
    startTime: '18:00',
    startsAt: '2026-10-30T23:00:00.000Z',
    sanctionBy: '2026-10-23',
    state: 'planned',
    inSchedule: null,
    organizer: { playerId: '9999991', name: 'Olive', connected: true, needsReconnect: false },
    product: 'tcg',
    category: 'tcg_std',
    type: { kind: 'custom' },
    displayId: null,
    upstreamStatus: null,
    errorCode: null,
    lastAttemptAt: null,
    skippedWhileUnknown: false,
    tdfAvailable: false,
    actions: ['create', 'skip'],
    ...overrides,
  };
}

describe('tournamentCards', () => {
  it('pairs each play-tools tournament with its Upcoming entry by guid, ignoring case, and lists the planned rows still to create', () => {
    const a = staffTournament({ tournamentId: GUID_A });
    const b = staffTournament({ tournamentId: GUID_B, label: 'Saturday Cup' });
    const aEntry = entry({ tournamentId: GUID_A.toUpperCase(), state: 'created', upstreamStatus: 'sanctioned', actions: [] });
    const planned = entry({ name: 'P', state: 'planned' });
    const failed = entry({ name: 'F', state: 'failed' });
    const creating = entry({ name: 'C', state: 'creating', actions: [] });
    const skipped = entry({ name: 'S', state: 'skipped', actions: ['unskip'] });
    const cancelled = entry({ name: 'X', state: 'cancelled', actions: [] });
    const unmatched = entry({ tournamentId: 'cccccccc-0000-4000-8000-000000000003', state: 'created', actions: [] });

    const { cards, planned: plannedCards } = tournamentCards(
      { tournaments: [a, b] },
      { tournaments: [planned, aEntry, failed, skipped, creating, cancelled, unmatched] },
    );

    expect(cards).toEqual([
      { tournament: a, entry: aEntry },
      { tournament: b, entry: null },
    ]);
    expect(plannedCards.map((e) => e.name)).toEqual(['P', 'F', 'C']);
  });

  it('shows every play-tools card without status, and no planned card, when Upcoming couldn’t be read', () => {
    const a = staffTournament();
    expect(tournamentCards({ tournaments: [a] }, null)).toEqual({ cards: [{ tournament: a, entry: null }], planned: [] });
  });

  it('keeps an unknown row (a create that may have landed) as a planned card for Retry create…', () => {
    const unknown = entry({ state: 'unknown', actions: ['retry_create'] });
    expect(tournamentCards({ tournaments: [] }, { tournaments: [unknown] }).planned).toEqual([unknown]);
  });
});

describe('cardEditable', () => {
  it("offers no Edit… on a tournament someone else's connection organizes (ADR-0015 §4)", () => {
    expect(cardEditable({ tournament: staffTournament(), entry: null }, 'Only Misty can change this')).toBe(false);
    expect(cardEditable({ tournament: staffTournament(), entry: entry({ tournamentId: GUID_A, state: 'created', actions: [] }) }, 'Only Misty')).toBe(false);
  });

  it('follows the paired entry’s actions', () => {
    expect(cardEditable({ tournament: staffTournament(), entry: entry({ tournamentId: GUID_A, state: 'created', actions: [] }) })).toBe(true);
    expect(cardEditable({ tournament: staffTournament(), entry: entry({ tournamentId: GUID_A, state: 'created', upstreamStatus: 'cancelled', actions: [] }) })).toBe(false);
  });

  it('without an entry, offers Edit… only on a listed tournament whose organizer can act', () => {
    expect(cardEditable({ tournament: staffTournament(), entry: null })).toBe(true);
    expect(cardEditable({ tournament: staffTournament({ missing: true, organizer: null }), entry: null })).toBe(false);
    expect(cardEditable({ tournament: staffTournament({ unavailable: true, organizer: null }), entry: null })).toBe(false);
    const reconnect = staffTournament({ organizer: { playerId: OLIVE, name: 'Olive', connected: true, needsReconnect: true } });
    expect(cardEditable({ tournament: reconnect, entry: null })).toBe(false);
    const notConnected = staffTournament({ organizer: { playerId: OLIVE, name: null, connected: false, needsReconnect: false } });
    expect(cardEditable({ tournament: notConnected, entry: null })).toBe(false);
  });
});

function section(overrides: Partial<ResultsSection> = {}): ResultsSection {
  return { upstream: { status: 'awaiting_results', reason: null }, latest: null, earlier: [], tdfAvailable: false, ...overrides };
}

function upload(overrides: Partial<ResultsUploadView> = {}): ResultsUploadView {
  return {
    uploadId: 7,
    state: 'previewed',
    filename: 'cup.tdf',
    playerCount: 12,
    warnings: [],
    fingerprint: 'f'.repeat(64),
    needsOrganizerFullName: null,
    errors: [],
    errorCode: null,
    acknowledged: null,
    submissionId: null,
    fileDeleted: false,
    createdAt: '2026-10-30T23:00:00.000Z',
    ...overrides,
  };
}

describe('resultsView', () => {
  it.each([
    [{ status: 'awaiting_results', reason: null }, 'Awaiting results', false, false],
    [{ status: 'processing', reason: null }, 'Processing in play-tools', false, false],
    [{ status: 'complete', reason: null }, 'Complete', false, false],
    [{ status: 'upload_failed', reason: null }, 'play-tools couldn’t process the last upload. Upload the file again.', false, false],
    [{ status: 'results_already_uploaded', reason: null }, 'play-tools already holds players for this tournament.', false, false],
    [{ status: 'results_not_accepted', reason: 'not_sanctioned' }, 'Results can be uploaded once it is sanctioned.', false, false],
    [{ status: 'results_not_accepted', reason: 'window_closed' }, 'The upload window has closed.', false, false],
    [{ status: 'results_not_accepted', reason: 'organizer_not_connected' }, 'Connect the organizer’s Pokémon account to upload results.', true, false],
    [{ status: 'results_not_accepted', reason: 'needs_reconnect' }, 'Reconnect the organizer to upload results.', true, false],
    [{ status: 'results_not_accepted', reason: 'something_new' }, 'play-tools won’t take an upload now.', false, false],
    [{ error: 'play-tools is unavailable.' }, 'play-tools is unavailable.', false, true],
  ] as const)('%j says %s', (upstream, text, settings, retry) => {
    expect(resultsView(section({ upstream: upstream as ResultsSection['upstream'] })).status).toEqual({ text, settings, retry });
  });

  it('offers the dropzone only while play-tools takes an upload and nothing is being sent', () => {
    expect(resultsView(section()).drop).toBe(true);
    expect(resultsView(section({ upstream: { status: 'upload_failed', reason: null } })).drop).toBe(true);
    expect(resultsView(section({ latest: upload({ state: 'not_accepted' }) })).drop).toBe(true);
    expect(resultsView(section({ latest: upload({ state: 'sending' }) })).drop).toBe(false);
    expect(resultsView(section({ upstream: { status: 'upload_failed', reason: null }, latest: upload({ state: 'processing' }) })).drop).toBe(false);
    for (const status of ['processing', 'complete', 'results_already_uploaded'] as const) {
      expect(resultsView(section({ upstream: { status, reason: null } })).drop).toBe(false);
    }
    expect(resultsView(section({ upstream: { status: 'results_not_accepted', reason: 'not_sanctioned' } })).drop).toBe(false);
    expect(resultsView(section({ upstream: { error: 'x' } })).drop).toBe(false);
  });

  it('offers Download TDF once the app holds the file, and says it has no copy when play-tools holds results it doesn’t', () => {
    const held = resultsView(section({ upstream: { status: 'complete', reason: null }, tdfAvailable: true }));
    expect(held).toMatchObject({ download: true, noCopy: false });
    for (const status of ['complete', 'processing', 'results_already_uploaded'] as const) {
      expect(resultsView(section({ upstream: { status, reason: null } }))).toMatchObject({ download: false, noCopy: true });
    }
    expect(resultsView(section())).toMatchObject({ download: false, noCopy: false });
  });

  it.each([
    ['previewed', 'Not sent yet', 'neutral'],
    ['sending', 'Sending…', 'info'],
    ['not_accepted', 'Not accepted', 'error'],
    ['warnings_changed', 'Warnings changed', 'warning'],
    ['validate_unknown', 'Outcome unknown', 'warning'],
    ['processing', 'Processing', 'info'],
    ['complete', 'Complete', 'success'],
    ['failed', 'Failed', 'error'],
  ] as const)('labels an upload %s as %s', (state, label, color) => {
    expect(resultsView(section({ latest: upload({ state }) })).latest).toMatchObject({ label, color });
  });

  it('explains a file play-tools didn’t accept, with each of its errors, and links its job', () => {
    const latest = upload({
      state: 'not_accepted',
      submissionId: 42,
      errors: [
        { code: 'STAFF_PLAYERS_ERROR', message: 'Staff are listed as players.', detail: null },
        { code: 'X', message: 'Something else.', detail: 'd' },
      ],
    });
    expect(resultsView(section({ latest })).latest).toEqual({
      label: 'Not accepted',
      color: 'error',
      lines: [
        'Staff are listed as players. (STAFF_PLAYERS_ERROR)',
        'Something else. (X)',
        'play-tools did not accept this file. Pokémon support can access the file from this failed attempt.',
      ],
      details: 42,
    });
  });

  it('says what an unknown outcome, changed warnings and a failure mean', () => {
    expect(resultsView(section({ latest: upload({ state: 'validate_unknown' }) })).latest?.lines).toEqual([
      'We couldn’t tell whether play-tools received this file. Pokémon support may have a copy. Check the tournament in play-tools before you upload again.',
    ]);
    expect(resultsView(section({ latest: upload({ state: 'warnings_changed' }) })).latest?.lines).toEqual(['The warnings changed since they were shown. Nothing was sent.']);
    expect(resultsView(section({ latest: upload({ state: 'failed', errorCode: 'interrupted' }) })).latest?.lines).toEqual(['interrupted']);
    expect(resultsView(section({ latest: upload({ state: 'complete' }) })).latest).toMatchObject({ lines: [], details: null });
  });

  it.each([
    ['not_accepted', true],
    ['warnings_changed', true],
    ['validate_unknown', true],
    ['failed', true],
    ['previewed', false],
    ['sending', false],
    ['processing', false],
    ['complete', false],
  ] as const)('offers Upload again… after %s: %s', (state, again) => {
    expect(resultsView(section({ latest: upload({ state }) })).again).toBe(again);
  });

  const AGAIN_STATES = ['not_accepted', 'warnings_changed', 'validate_unknown', 'failed'] as const;

  it.each(AGAIN_STATES)('still offers Upload again… after %s once play-tools couldn’t process the last upload', (state) => {
    expect(resultsView(section({ upstream: { status: 'upload_failed', reason: null }, latest: upload({ state }) })).again).toBe(true);
  });

  it.each(
    (['complete', 'processing', 'results_already_uploaded'] as const).flatMap((status) => AGAIN_STATES.map((state) => [status, state] as const)),
  )('offers no Upload again… once play-tools holds results (%s), even after %s', (status, state) => {
    expect(resultsView(section({ upstream: { status, reason: null }, latest: upload({ state }) })).again).toBe(false);
  });

  it.each([
    [{ status: 'results_not_accepted', reason: 'window_closed' }],
    [{ status: 'results_not_accepted', reason: 'needs_reconnect' }],
    [{ error: 'play-tools is unavailable.' }],
  ] as const)('offers no Upload again… while play-tools won’t take an upload or can’t be read: %j', (upstream) => {
    const view = resultsView(section({ upstream: upstream as ResultsSection['upstream'], latest: upload({ state: 'failed' }) }));
    expect(view).toMatchObject({ again: false, drop: false });
  });

  it('asks for the file again instead of Upload again… once it was deleted', () => {
    expect(resultsView(section({ latest: upload({ state: 'not_accepted', fileDeleted: true }) }))).toMatchObject({ again: false, fileDeleted: true, drop: true });
  });

  it('offers Review upload… for an open preview, so a closed dialog or a reload picks it up', () => {
    expect(resultsView(section({ latest: upload({ state: 'previewed' }) }))).toMatchObject({ review: true, again: false });
    expect(resultsView(section({ latest: upload({ state: 'not_accepted' }) })).review).toBe(false);
    expect(resultsView(section()).latest).toBeNull();
  });
});

const W = {
  organizerReplaced: { code: 'tdf_organizer_replaced', message: 'org', from: { playerId: '1', name: 'A' }, to: { playerId: '2', name: 'B' } },
  wrongOrganizer: { code: 'tdf_wrong_organizer', message: 'wo', filePlayerId: null },
  idFilled: { code: 'tdf_tournament_id_filled', message: 'id', displayId: '26-10-000001' },
  wrongTournament: { code: 'tdf_wrong_tournament', message: 'wt', fileTournamentId: '26-10-000009' },
  wrongGame: { code: 'tdf_wrong_game', message: 'wg', fileProduct: 'vg' },
  staff1: { code: 'tdf_staff_also_playing', message: 's1', player: { playerId: '11', name: 'Ash', role: 'judge', removable: true } },
  staff2: { code: 'tdf_staff_also_playing', message: 's2', player: { playerId: '12', name: 'Misty', role: 'scorekeeper', removable: true } },
  unknown: { code: 'tdf_unknown_players', message: 'u', players: [{ playerId: '99', name: 'New', knownAs: null }] },
} satisfies Record<string, ResultsWarning>;

describe('orderedWarnings', () => {
  it('lists a replaced organizer first and players new to the app last, keeping each code’s own order', () => {
    const scrambled = [W.unknown, W.staff1, W.wrongGame, W.idFilled, W.staff2, W.organizerReplaced, W.wrongTournament, W.wrongOrganizer];
    expect(orderedWarnings(scrambled).map((w) => w.message)).toEqual(['org', 'wo', 'id', 'wt', 'wg', 's1', 's2', 'u']);
  });
});

describe('uploadButtonLabel', () => {
  it.each([
    [[], 'Upload results'],
    [[W.organizerReplaced], 'Replace organizer and upload'],
    [[W.idFilled], 'Fill in id and upload'],
    [[W.organizerReplaced, W.idFilled], 'Upload anyway'],
    [[W.wrongGame], 'Upload anyway'],
    [[W.staff1], 'Upload anyway'],
  ] as const)('%# → %s', (warnings, label) => {
    expect(uploadButtonLabel(warnings)).toBe(label);
  });
});

describe('uploadAgainOffered', () => {
  const job = (status: SubmissionView['status'], outcome: TournamentItemOutcome | null, kind: SubmissionView['kind'] = 'tdf_upload') => ({
    kind,
    status,
    tournamentItems: outcome ? [{ outcome }] : [],
  }) as unknown as Pick<SubmissionView, 'kind' | 'status' | 'tournamentItems'>;

  it.each([
    ['not accepted', job('succeeded', 'not_accepted'), true],
    ['warnings changed', job('failed', 'warnings_changed'), true],
    ['outcome unknown', job('failed', 'validate_unknown'), true],
    ['still processing', job('succeeded', 'processing'), false],
    ['uploaded', job('succeeded', 'uploaded'), false],
    ['interrupted', job('interrupted', null), true],
    ['failed before sending', job('failed', null), true],
    ['another kind of job', job('failed', null, 'tournament_create'), false],
  ] as const)('%s → %s', (_, view, offered) => {
    expect(uploadAgainOffered(view)).toBe(offered);
  });
});

describe('refusals the upload dialog acts on', () => {
  const fetchError = (data: Record<string, unknown>) => ({ statusCode: 422, data: { message: 'refused', data } });

  it('takes the current warnings and fingerprint from a stale acknowledgment, and nothing from any other error', () => {
    const fingerprint = 'a'.repeat(64);
    expect(staleWarnings(fetchError({ code: 'warnings_not_acknowledged', warnings: [W.wrongGame], fingerprint }))).toEqual({ warnings: [W.wrongGame], fingerprint });
    expect(staleWarnings(fetchError({ code: 'not_found' }))).toBeNull();
    expect(staleWarnings(fetchError({ code: 'warnings_not_acknowledged', warnings: 'nope', fingerprint }))).toBeNull();
    expect(staleWarnings(new Error('network'))).toBeNull();
  });

  it('says why each player can’t be removed from staff', () => {
    const err = fetchError({
      code: 'not_removable',
      failures: [
        { playerId: '11', reason: 'not_in_file' },
        { playerId: '12', reason: 'not_staff' },
        { playerId: '13', reason: 'organizer' },
      ],
    });
    expect(notRemovableLines(err)).toEqual(['11: not in this file', '12: no longer on staff', '13: the organizer']);
    expect(notRemovableLines(fetchError({ code: 'submission_running' }))).toEqual([]);
  });
});
