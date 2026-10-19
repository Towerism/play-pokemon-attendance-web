import { describe, expect, it } from 'vitest';
import { InviteAcceptBody, InviteCheckBody, MintInviteBody, MintResetBody, ProfessorIdParam } from './professors';

describe('MintInviteBody', () => {
  it('takes an optional trimmed label and bound player ID, and a send choice', () => {
    expect(MintInviteBody.parse({ send: 'copy', label: '  Misty  ', playerId: '0012345' })).toEqual({ send: 'copy', label: 'Misty', playerId: '0012345' });
    expect(MintInviteBody.parse({ send: 'copy' })).toEqual({ send: 'copy' });
  });

  it.each([
    [{}],
    [{ send: 'fax' }],
    [{ send: 'copy', label: 'x'.repeat(61) }],
    [{ send: 'copy', label: '   ' }],
    [{ send: 'copy', playerId: 'abc' }],
    [{ send: 'discord' }],
  ])('refuses %j', (body) => {
    expect(MintInviteBody.safeParse(body).success).toBe(false);
  });

  it('needs a bound player ID to send by Discord', () => {
    expect(MintInviteBody.parse({ send: 'discord', playerId: '0012345' })).toEqual({ send: 'discord', playerId: '0012345' });
  });
});

describe('MintResetBody', () => {
  it('takes only a send choice', () => {
    expect(MintResetBody.parse({ send: 'discord' })).toEqual({ send: 'discord' });
    expect(MintResetBody.safeParse({}).success).toBe(false);
  });
});

describe('ProfessorIdParam', () => {
  it('coerces a positive id and refuses anything else', () => {
    expect(ProfessorIdParam.parse({ userId: '12' })).toEqual({ userId: 12 });
    for (const userId of ['0', 'abc', '1'.repeat(17)]) expect(ProfessorIdParam.safeParse({ userId }).success).toBe(false);
  });
});

describe('the public invite bodies', () => {
  it('take a secret of at most 200 characters, malformed or not', () => {
    expect(InviteCheckBody.parse({ secret: 'abc' })).toEqual({ secret: 'abc' });
    expect(InviteCheckBody.safeParse({ secret: 'x'.repeat(201) }).success).toBe(false);
    expect(InviteCheckBody.safeParse({}).success).toBe(false);
  });

  it("hold accept to setup's username and password rules, with the username optional for a reset link", () => {
    expect(InviteAcceptBody.parse({ secret: 's', username: ' Misty ', password: 'x'.repeat(8) })).toEqual({ secret: 's', username: 'misty', password: 'x'.repeat(8) });
    expect(InviteAcceptBody.parse({ secret: 's', password: 'x'.repeat(8) })).toEqual({ secret: 's', password: 'x'.repeat(8) });
    for (const body of [
      { secret: 's', username: 'misty', password: 'x'.repeat(7) },
      { secret: 's', username: 'misty', password: 'x'.repeat(257) },
      { secret: 's', username: 'ms', password: 'x'.repeat(8) },
      { secret: 's', username: 'bad name!', password: 'x'.repeat(8) },
    ]) {
      expect(InviteAcceptBody.safeParse(body).success).toBe(false);
    }
  });
});
