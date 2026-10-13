/** The token in an `Authorization: Bearer <token>` header (scheme in any case), or null for anything else. */
export function parseBearer(header: string | undefined): string | null {
  const match = /^bearer +(\S+)$/i.exec(header?.trim() ?? '');
  return match ? match[1]! : null;
}
