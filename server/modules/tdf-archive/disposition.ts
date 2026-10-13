/**
 * `Content-Disposition: attachment` for a stored file's original name: an ASCII-only `filename` for old
 * clients (quotes, backslashes, control and non-ASCII characters become `_`) and the exact name as an
 * RFC 5987 `filename*`. No raw CR, LF or quote reaches the header.
 */
export function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
