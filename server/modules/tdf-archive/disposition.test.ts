import { describe, expect, it } from 'vitest';
import { attachmentDisposition } from './disposition';

describe('attachmentDisposition', () => {
  it('names a plain file as is', () => {
    expect(attachmentDisposition('cup.tdf')).toBe(`attachment; filename="cup.tdf"; filename*=UTF-8''cup.tdf`);
  });

  it('keeps quotes, backslashes, line breaks and non-ASCII out of the plain name, and the full name in filename*', () => {
    expect(attachmentDisposition('Café "Cup"\\\r\nX.tdf')).toBe(
      `attachment; filename="Caf_ _Cup____X.tdf"; filename*=UTF-8''Caf%C3%A9%20%22Cup%22%5C%0D%0AX.tdf`,
    );
  });

  it("percent-encodes the characters encodeURIComponent leaves alone but RFC 5987 doesn't allow", () => {
    expect(attachmentDisposition("it's (1)*.tdf")).toBe(`attachment; filename="it's (1)*.tdf"; filename*=UTF-8''it%27s%20%281%29%2A.tdf`);
  });
});
