# ADR-0001: Modular monolith in TypeScript (Fastify + React SPA)

- Status: Proposed
- Date: 2026-10-10

## Context

There is one developer and one or two organizers per league. The scale is
tens of players per week. The only complicated part is an unofficial
third-party integration, and the predecessor tool is Node.js.

## Options considered

1. **Next.js full-stack.** One framework, with server actions and SSR. But SSR isn't needed behind a login. Long-running background jobs (a 15 s+ throttled submission) and SSE fit awkwardly in serverless or route handlers, and it pushes toward Vercel, where a SQLite file doesn't work.
2. **Fastify API + React (Vite) SPA, one process.** Explicit, long-lived process for jobs and timers. Fastify serves the SPA, so there is one origin.
3. **Python (FastAPI) + React.** Fine, but it means two languages and no shared schemas, and the TDF/JS knowledge already exists.
4. **Microservices.** Not justified: there are no independent scaling or team boundaries.

## Decision

Option 2: a **modular monolith** with a pnpm workspace (`apps/web`,
`apps/server`, `packages/shared`, `packages/tdf`) and a hexagonal port
boundary around the Pokémon APIs.

## Consequences

- (+) One deployable, one language, and Zod schemas shared end to end.
- (+) In-process jobs and timers (submission runner, token keep-alive) need no queue infrastructure.
- (−) It runs as a single instance only. The job runner and per-league lock assume one process, which is acceptable at this scale. If multiple instances are ever needed, move jobs to a DB-backed queue (e.g. a `jobs` table with leases) first.
