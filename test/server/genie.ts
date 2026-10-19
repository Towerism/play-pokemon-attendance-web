import { expect } from 'vitest';
import type { client } from './harness';

type Browser = ReturnType<typeof client>;

export interface GenieMessage {
  id: number;
  playerId: string;
  text: string;
  link: { label: string; url: string } | null;
  expiresAt: string;
}

/**
 * Tournament Genie's side of the Discord channel (ADR-0015 §7), played over HTTP with a real bearer token, the way
 * Genie calls: no session cookie. Server tests and E2E journeys use it alike.
 */
export interface Genie {
  secret: string;
  /** `GET /api/integrations/v1/messages`; resolves with the raw response. */
  pollResponse(opts?: { wait?: number; limit?: number; signal?: AbortSignal }): Promise<Response>;
  /** A poll that must answer 200; resolves with its messages. */
  poll(opts?: { wait?: number; limit?: number; signal?: AbortSignal }): Promise<GenieMessage[]>;
  /** `POST /api/integrations/v1/messages/{id}/result`. */
  report(id: number, status: string, reason?: string): Promise<Response>;
}

/** Mints a token with `scopes` through Settings' route, as the owner. */
export async function mintToken(owner: Browser, scopes: string[] = ['messages:deliver'], label = 'Tournament Genie'): Promise<string> {
  const res = await owner.request('/api/integrations/tokens', { method: 'POST', json: { label, scopes } });
  expect(res.status, 'mint integration token').toBe(201);
  return ((await res.json()) as { secret: string }).secret;
}

export function genieWith(baseUrl: string, secret: string): Genie {
  const headers = { authorization: `Bearer ${secret}` };
  const pollResponse: Genie['pollResponse'] = ({ wait, limit, signal } = {}) => {
    const q = new URLSearchParams();
    if (wait !== undefined) q.set('wait', String(wait));
    if (limit !== undefined) q.set('limit', String(limit));
    return fetch(`${baseUrl}/api/integrations/v1/messages${q.size ? `?${q}` : ''}`, { headers, signal });
  };
  return {
    secret,
    pollResponse,
    async poll(opts) {
      const res = await pollResponse(opts);
      expect(res.status, 'Genie poll').toBe(200);
      return ((await res.json()) as { messages: GenieMessage[] }).messages;
    },
    report: (id, status, reason) =>
      fetch(`${baseUrl}/api/integrations/v1/messages/${id}/result`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(reason === undefined ? { status } : { status, reason }),
      }),
  };
}

/** Mints a `messages:deliver` token and polls once, so the channel counts Genie as connected. */
export async function connectGenie(baseUrl: string, owner: Browser): Promise<Genie> {
  const genie = genieWith(baseUrl, await mintToken(owner));
  await genie.poll();
  return genie;
}
