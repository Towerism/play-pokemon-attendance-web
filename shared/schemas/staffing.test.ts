import { describe, expect, it } from 'vitest';
import { AddStaffBody, ChangeStaffRoleBody, StaffAssignmentParams, StaffQuery } from './staffing';

describe('AddStaffBody', () => {
  const valid = { tournamentId: 'b2c4e6f8-1a3c-4e5f-9a7b-0123456789ab', playerId: '00123', role: 'judge' };

  it('keeps the leading zeros of the player id and drops a blank name', () => {
    expect(AddStaffBody.parse({ ...valid, name: '  ' })).toEqual(valid);
    expect(AddStaffBody.parse({ ...valid, name: ' Brock ' })).toEqual({ ...valid, name: 'Brock' });
  });

  it.each(['../x', 'a/b', '', 'x'.repeat(65), 't 1'])('refuses the tournament id %j', (tournamentId) => {
    expect(AddStaffBody.safeParse({ ...valid, tournamentId }).success).toBe(false);
  });

  it('accepts a 64-character tournament id', () => {
    expect(AddStaffBody.safeParse({ ...valid, tournamentId: 'a'.repeat(64) }).success).toBe(true);
  });

  it.each([{ playerId: '12a' }, { playerId: 123 }, { role: '' }, { role: 5 }, { name: 'x'.repeat(101) }])('refuses %j', (patch) => {
    expect(AddStaffBody.safeParse({ ...valid, ...patch }).success).toBe(false);
  });

  it.each(['tournamentId', 'playerId', 'role'])('requires %s', (key) => {
    const body = Object.fromEntries(Object.entries(valid).filter(([k]) => k !== key));
    expect(AddStaffBody.safeParse(body).success).toBe(false);
  });
});

describe('ChangeStaffRoleBody', () => {
  it('takes a role', () => {
    expect(ChangeStaffRoleBody.parse({ role: 'scorekeeper' })).toEqual({ role: 'scorekeeper' });
  });

  it.each([{}, { role: '' }, { role: null }])('refuses %j', (body) => {
    expect(ChangeStaffRoleBody.safeParse(body).success).toBe(false);
  });
});

describe('StaffAssignmentParams', () => {
  it('reads the assignment id as a number', () => {
    expect(StaffAssignmentParams.parse({ date: '2026-10-14', assignmentId: '42' })).toEqual({ date: '2026-10-14', assignmentId: 42 });
  });

  it.each(['0', '-1', '1.5', 'abc', ''])('refuses the assignment id %j', (assignmentId) => {
    expect(StaffAssignmentParams.safeParse({ date: '2026-10-14', assignmentId }).success).toBe(false);
  });
});

describe('StaffQuery', () => {
  it('takes an optional search and limit, dropping a blank search', () => {
    expect(StaffQuery.parse({})).toEqual({});
    expect(StaffQuery.parse({ q: ' ash ', limit: '20' })).toEqual({ q: 'ash', limit: 20 });
    expect(StaffQuery.parse({ q: ' ' })).toEqual({});
  });

  it.each(['0', '101', '2.5', 'abc', '-1', ''])('refuses limit=%j', (limit) => {
    expect(StaffQuery.safeParse({ limit }).success).toBe(false);
  });

  it('refuses a search over 100 characters', () => {
    expect(StaffQuery.safeParse({ q: 'x'.repeat(101) }).success).toBe(false);
  });
});
