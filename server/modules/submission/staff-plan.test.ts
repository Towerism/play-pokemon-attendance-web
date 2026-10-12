import { describe, expect, it } from 'vitest';
import type { PlayerId } from '../../../shared/types/ids';
import type { StaffRole, TournamentParticipant } from '../pokemon/ports/play-tools-gateway';
import { classifyStaffer, refusalMessage } from './staff-plan';

const id = (s: string) => s as PlayerId;
const ORGANIZER = id('9999991');
const ROLES: readonly StaffRole[] = [
  { code: 'judge', label: 'Judge' },
  { code: 'scorekeeper', label: 'Scorekeeper' },
];

const staff = (playerId: string, role: string, recordId = `up-${playerId}`): TournamentParticipant => ({
  recordId,
  playerId: id(playerId),
  role,
  isStaff: true,
  name: '',
});
const player = (playerId: string): TournamentParticipant => ({ recordId: `pl-${playerId}`, playerId: id(playerId), role: null, isStaff: false, name: '' });
const organizerRecord = staff('9999991', 'organizer', 'org-rec');

const classify = (wanted: { playerId: string; role: string; recordId?: string | null }, listed: TournamentParticipant[]) =>
  classifyStaffer({ playerId: id(wanted.playerId), role: wanted.role, recordId: wanted.recordId ?? null }, listed, ORGANIZER, ROLES);

describe('classifyStaffer (ADR-0007 decisions 8 and 9: decided from a fresh read)', () => {
  it('assigns a player the tournament does not list at all', () => {
    expect(classify({ playerId: '1', role: 'judge' }, [organizerRecord, player('2')])).toEqual({ kind: 'assign' });
  });

  it("never assigns the tournament's organizer, even when their record is missing from the listing", () => {
    expect(classify({ playerId: '9999991', role: 'judge' }, [])).toEqual({ kind: 'is_organizer' });
    expect(classify({ playerId: '9999991', role: 'judge' }, [organizerRecord])).toEqual({ kind: 'is_organizer' });
  });

  it('calls a player listed as a player already_listed, saying how', () => {
    expect(classify({ playerId: '1', role: 'judge' }, [player('1')])).toEqual({ kind: 'already_listed', how: 'Listed as a player' });
  });

  it('adopts a record listing the player as staff in the wanted role (already_assigned)', () => {
    expect(classify({ playerId: '1', role: 'judge' }, [staff('1', 'judge', 'theirs')])).toEqual({ kind: 'already_assigned', recordId: 'theirs' });
  });

  it("calls staff in another role on a record this app doesn't hold already_listed, with the role's label", () => {
    expect(classify({ playerId: '1', role: 'judge' }, [staff('1', 'scorekeeper', 'theirs')])).toEqual({
      kind: 'already_listed',
      how: 'Listed as Scorekeeper',
    });
  });

  it('shows a role the app does not offer as its raw code', () => {
    expect(classify({ playerId: '1', role: 'judge' }, [staff('1', 'streamer')])).toEqual({ kind: 'already_listed', how: 'Listed as streamer' });
  });

  it('re-roles only the record this app holds for the assignment', () => {
    expect(classify({ playerId: '1', role: 'judge', recordId: 'ours' }, [staff('1', 'scorekeeper', 'ours')])).toEqual({
      kind: 'rechange',
      recordId: 'ours',
    });
  });

  it('is already_assigned when our own record already holds the wanted role', () => {
    expect(classify({ playerId: '1', role: 'judge', recordId: 'ours' }, [staff('1', 'judge', 'ours')])).toEqual({
      kind: 'already_assigned',
      recordId: 'ours',
    });
  });

  it('assigns afresh when our record is gone and the player is no longer listed', () => {
    expect(classify({ playerId: '1', role: 'judge', recordId: 'ours' }, [organizerRecord])).toEqual({ kind: 'assign' });
  });

  it('never touches a player listed twice (as a player and as staff): already_listed as a player', () => {
    expect(classify({ playerId: '1', role: 'judge', recordId: 'ours' }, [staff('1', 'judge', 'ours'), player('1')])).toEqual({
      kind: 'already_listed',
      how: 'Listed as a player',
    });
  });

  it('compares player ids exactly as text, so leading zeros count', () => {
    expect(classify({ playerId: '00123', role: 'judge' }, [player('123')])).toEqual({ kind: 'assign' });
    expect(classify({ playerId: '0009999991', role: 'judge' }, [])).toEqual({ kind: 'assign' });
  });
});

describe('refusalMessage (ADR-0007 decision 10: eligibility is upstream’s call)', () => {
  it.each([
    ['missing_certification', "missing_certification: Not certified for this role at this tournament's product"],
    ['player_id_must_be_claimed', "player_id_must_be_claimed: Player ID isn't claimed"],
    ['below_age', 'below_age: Below the minimum age'],
    ['disciplined', 'disciplined: Disciplined'],
    ['no_user', 'no_user: No Pokémon account for this player ID'],
    ['unknown_reference', 'unknown_reference: Not a valid player ID'],
  ])('explains %s', (code, message) => {
    expect(refusalMessage(code)).toBe(message);
  });

  it('names the id a merged player id was merged into, as a suggestion only', () => {
    expect(refusalMessage('merged_player_id', id('09876'))).toBe('merged_player_id: Merged into 09876. Edit the assignment to use that ID');
  });

  it('keeps a code it does not know as the raw code', () => {
    expect(refusalMessage('brand_new_rule')).toBe('brand_new_rule');
  });
});
