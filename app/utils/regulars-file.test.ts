import { describe, expect, it } from 'vitest';
import { REGULARS_FILE_MAX_BYTES, readRegularsFile } from './regulars-file';

const file = (text: string, name = 'regulars.json') => new File([text], name, { type: 'application/json' });

describe('readRegularsFile', () => {
  it('returns the parsed JSON for the server to validate', async () => {
    const json = [{ name: 'Ash', player_id: '0012345' }];
    expect(await readRegularsFile(file(JSON.stringify(json)))).toEqual({ ok: true, value: json });
  });

  it('explains a file that is not JSON', async () => {
    expect(await readRegularsFile(file('name,player_id\nAsh,1', 'regulars.csv'))).toEqual({
      ok: false,
      error: 'regulars.csv is not a JSON file.',
    });
  });

  it('refuses an oversized file before reading it', async () => {
    const big = file('x'.repeat(REGULARS_FILE_MAX_BYTES + 1));
    expect(await readRegularsFile(big)).toEqual({ ok: false, error: 'regulars.json is too large (max 1 MB).' });
  });
});
