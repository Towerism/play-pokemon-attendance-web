# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

A web app that replaces the [play-pokemon-attendance CLI](https://github.com/Towerism/play-pokemon-attendance)
for entering Play! Pokémon league attendance into `play-tools.pokemon.com`:
curated regulars, per-date session players, `.tdf` import, one-click
idempotent submission, and sightings-based curation metrics.

## Architecture is decided — read it first

The system was designed with the `/engineering-skills:senior-architect` skill.
The design lives in [`docs/architecture/README.md`](docs/architecture/README.md)
and the ADRs in [`docs/architecture/adr/`](docs/architecture/adr/). Treat them
as the source of truth:

- Build what the docs describe. Don't swap the stack, pattern or data model on your own.
- If a change needs to depart from the design, say so and propose an ADR
  (new file in `docs/architecture/adr/`, next number) or an update to the
  affected ADR — use `/engineering-skills:senior-architect` for that work.
- Keep the architecture doc in sync when code makes it out of date.

Key points (details in the docs):

- **One Nuxt 4 app**, Nitro `node-server` preset, single Docker container (ADR-0001).
  Vue in `app/`, Nitro routes/plugins/tasks in `server/`, Zod schemas and the pure
  TDF parser in `shared/`.
- **SQLite (WAL) + Drizzle**, Litestream backups (ADR-0002). Avoid SQLite-only SQL outside metrics views.
- **Pokémon auth:** one-time PKCE connect, refresh token stored AES-256-GCM encrypted;
  persist the rotated refresh token before anything else (ADR-0003).
- **Submission is plan → execute → reconcile**, diffed against upstream; never
  auto-delete upstream records (ADR-0004).
- **Metrics come from sightings, not submissions** (ADR-0005).

Module rules (enforce, don't erode):

- `server/api/*` handlers are thin: `requireUserSession`, validate with shared Zod
  schemas, call a module service, map errors.
- `server/modules/*` are plain TS — no h3 or Nuxt imports.
- Modules talk only through each other's exported services, never each other's tables.
- Only `server/modules/pokemon/adapters/*` may call `*.pokemon.com`. Upstream payload
  shapes never leak past the `PlayToolsGateway` / `TokenProvider` ports.
- `player_id` is TEXT everywhere.

## Writing code: TDD, always

**Follow the `/engineering-skills:tdd-guide` skill for absolutely any code** —
features, bug fixes, refactors, adapters, scripts, config with behavior. No
production code without a failing test first.

1. **Red** — write one failing test for the next small behavior. Run it and see it fail for the right reason.
2. **Green** — write the minimum code to pass. Run the tests.
3. **Refactor** — clean up with the tests green.

Repeat in small steps. Don't batch several behaviors into one cycle, and don't
write the implementation before the test "to save time".

## Designing tests

Before writing tests, load **`/engineering-skills:senior-qa`** and
**`/engineering-advanced-skills:api-test-suite-builder`** so tests target the
behavior that matters, not line coverage. Aim tests at the ranked quality
attributes — correctness of submitted attendance comes first.

Planned tooling (architecture §3): Vitest + `@nuxt/test-utils` for unit,
component and server-route tests; MSW for the Pokémon APIs; Playwright for one
happy-path E2E.

High-value areas:

- **`shared/tdf` parser** — pure, heavily unit-tested: real TDF shapes, dedupe,
  invalid IDs, leading zeros, XXE/entity payloads, size and player caps, no PII beyond name + ID.
- **Submission job** — plan diff (desired − existing), batching and throttling,
  partial failures, reconcile outcomes, retry/resume idempotency, the per-league lock.
- **Token provider** — cache window, refresh-token rotation persisted first,
  concurrent refresh mutex, `invalid_grant` → `needs_reconnect`.
- **Pokémon adapters** — contract tests against recorded fixtures (spikes S3–S5);
  unexpected shapes fail loudly. No real network calls in tests.
- **API routes** — auth required on every route, input validation, status codes, error mapping.
- **Metrics views** — windowed counts, streaks and promote/stale thresholds from sightings.

## Security musts

- Never log, return to the browser, or commit the refresh token or access token.
  Logs redact `authorization` and `*token*`.
- Secrets come from env (`NUXT_TOKEN_VAULT_KEY`, `NUXT_SESSION_PASSWORD`, …), never the DB or repo.
- Never persist TDF birthdates or raw TDF files.
- Never store the organizer's PTC password; no headless-browser login.
- Keep outbound play-tools traffic human-scale (≥ 15 s between bulk batches by default).

## Toolchain

Node 22 (see `.node-version` once scaffolded) with pnpm. Lint with
`@nuxt/eslint`, typecheck with `vue-tsc`. Add the concrete commands
(`dev`, `test`, `lint`, `typecheck`, `build`) here when the project is scaffolded (M1).

## Status

Docs only so far. Next is M0 (spikes S1–S5) and M1 (Nuxt skeleton); see the
delivery plan in architecture §13.
