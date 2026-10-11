import { describe, expect, it } from 'vitest';
import { apiErrorMessage } from './api-error';

const zodIssues = (message: string) => JSON.stringify([{ code: 'invalid_format', path: ['playerId'], message }]);

describe('apiErrorMessage', () => {
  it('shows the first validation issue instead of the raw issue list', () => {
    const err = { statusCode: 400, data: { statusMessage: 'Validation Error', message: zodIssues('Player IDs are 1–12 digits') } };
    expect(apiErrorMessage(err)).toBe('Player IDs are 1–12 digits');
  });

  it('shows the server message for other errors', () => {
    expect(apiErrorMessage({ statusCode: 409, data: { message: 'Player 9 is a regular.' } })).toBe('Player 9 is a regular.');
  });

  it('falls back when a validation message is not an issue list', () => {
    expect(apiErrorMessage({ statusCode: 400, data: { statusMessage: 'Validation Error', message: 'nope' } })).toBe('nope');
  });

  it.each([undefined, new Error('network'), { statusCode: 500 }])('uses the fallback for %j', (err) => {
    expect(apiErrorMessage(err, 'Could not save.')).toBe('Could not save.');
  });
});
