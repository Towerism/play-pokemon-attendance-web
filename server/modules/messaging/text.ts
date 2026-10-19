/**
 * Removes Discord mention syntax from a name or label placed in a message, so it can't ping anyone even if Genie's
 * guard failed (ADR-0015 §7). Feature-blind: every sender's fixed templates use it.
 */
export function withoutMentions(name: string): string {
  return name.replace(/<(?:@[!&]?|#)\d+>/g, '').replaceAll('@', '');
}
