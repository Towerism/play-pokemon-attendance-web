# ADR-0001: Modular monolith on Nuxt 4 (Vue + Nitro)

- Status: Accepted (retroactively, 2026-10-12; implemented in M1–M8)
- Date: 2026-10-10
- Revision: replaces an earlier draft that proposed Fastify + a React SPA. The owner prefers the Nuxt ecosystem.

## Context

There is one developer and one or two organizers per league. The scale is
tens of players per week. The only complicated part is an unofficial
third-party integration, and the predecessor tool is Node.js. The owner wants
to build in the **Nuxt ecosystem**.

The system needs:
- a server that can run **long-lived background work**: a submission job that sleeps ≥ 15 s between batches, plus an hourly token keep-alive;
- server-sent progress events;
- a secret that must never reach the browser (the refresh token).

## Options considered

1. **Nuxt 4 full-stack (Vue pages + Nitro server routes) on the `node-server` preset.**
   - One project, one build and one origin.
   - Nitro gives file-based API routes, plugins (boot-time job runner), `tasks` + `scheduledTasks` (cron), and SSE via h3 `createEventStream`.
   - Typed `$fetch` comes for free from server routes.
2. **Nuxt (SPA only) + a separate Fastify/Nitro API service.** This adds a second deployable and CORS or proxy configuration for no benefit at this scale.
3. **Nuxt on serverless (Vercel / Netlify / Cloudflare) with NuxtHub / D1.** Cheap and zero-ops, but serverless can't hold a multi-minute throttled job or an in-memory token cache. That would force a queue (e.g. Cloudflare Queues + Durable Objects) and redesign the job runner. Revisit only if hosting a container becomes a burden.

## Decision

Option 1: **one Nuxt 4 application**, built with the Nitro `node-server`
preset and shipped as a single Docker container. Production runs it on
Unraid ([ADR-0006](0006-docker-on-unraid.md)).

| Concern          | Nuxt-ecosystem choice                                                      |
| ---------------- | -------------------------------------------------------------------------- |
| UI kit           | Nuxt UI                                                                    |
| Server state     | `useFetch` / `useAsyncData` (+ `refreshNuxtData`)                          |
| UI state         | Pinia (`@pinia/nuxt`)                                                       |
| App auth         | `nuxt-auth-utils`                                                          |
| Security headers / rate limits | `nuxt-security`, `nuxt-csurf`                                |
| Background work  | Nitro plugin (job runner) + Nitro scheduled task (keep-alive)              |
| Shared code      | Nuxt 4 `shared/` dir (Zod schemas, TDF parser), auto-imported on both sides |
| Testing          | Vitest + `@nuxt/test-utils`, Playwright                                    |
| Lint             | `@nuxt/eslint`                                                             |

App pages render client-side (`ssr: false` via `routeRules`): everything is
behind a login, and this avoids SSR and auth-cookie hydration edge cases.

Domain logic lives in `server/modules/*` as framework-free TypeScript. Nitro
handlers are thin adapters, and a hexagonal port boundary sits around the
Pokémon APIs.

## Consequences

- (+) One deployable, one language, and Zod schemas shared end to end with no workspace plumbing.
- (+) Nuxt's conventions (file-based pages and routes, auto-imports, runtimeConfig) remove most boilerplate.
- (+) In-process jobs and timers need no queue infrastructure.
- (−) It runs as a single instance only. The job runner and per-league lock assume one process, which is acceptable at this scale. If multiple instances are ever needed, move jobs to a DB-backed queue (`jobs` table with leases) first.
- (−) Nitro `tasks` / `scheduledTasks` are still flagged `experimental`. If they change, the keep-alive is a 10-line `setInterval` in a Nitro plugin instead.
- (−) It is tied to a long-lived Node host, so serverless presets are out of scope for v1 (see option 3).
