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
  persist the rotated refresh token before anything else (ADR-0003). One connection per
  professor, keyed by player ID; the league names the submitting professor, and attendance calls
  are made as them (ADR-0008). Tournament calls are made as each tournament's organizer, and the
  league must be one every connected professor shares (ADR-0009).
- **Submission is plan → execute → reconcile**, diffed against upstream; never
  auto-delete upstream records (ADR-0004).
- **Metrics come from sightings, not submissions** (ADR-0005).
- **Production is a Docker container on Unraid** (ADR-0006). The install must stay
  painless: no required template fields, everything persistent under `/data`,
  PUID/PGID 99/100, honour `TZ`. Credentials (organizer login, Pokémon connect)
  are set up in the browser, never in the template.

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

**Exception: CI/CD pipelines** (`.github/workflows/*`). No TDD and no tests for
pipeline changes. Use the `/engineering-advanced-skills:ci-cd-pipeline-builder`
skill when creating or editing a pipeline instead.

## Designing tests

Before writing tests, load **`/engineering-skills:senior-qa`** and
**`/engineering-advanced-skills:api-test-suite-builder`** so tests target the
behavior that matters, not line coverage. Aim tests at the ranked quality
attributes — correctness of submitted attendance comes first.

Tooling (architecture §3): Vitest + `@nuxt/test-utils` for unit and server
tests; the in-process HTTP fake `test/server/fake-pokemon.ts` for the Pokémon
APIs (server and E2E tests); Playwright for the browser journeys in `test/e2e/`
(client-side decisions only, not the server API matrix).

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
  Logs redact an exact list of keys (token, access/refresh/id token, authorization, cookie,
  password, secret, birthdate/dob, … — architecture §10) before formatting; look-alikes like
  `tokenCount` stay visible. Log through `useLogger` / an injected `Logger`, never `console`.
- Secrets come from env (`NUXT_TOKEN_VAULT_KEY`, `NUXT_SESSION_PASSWORD`, …) or, when
  unset, from files generated once in `/data/secrets/` (mode 0600). Never the DB or repo.
- Never persist TDF birthdates or raw TDF files.
- Never store the organizer's PTC password; no headless-browser login.
- Keep outbound play-tools traffic human-scale: one bulk batch at a time, by default 20 players at least 10 s apart (ADR-0004 update; never more than 50 per batch).

## Toolchain

Node 22 (`.node-version`) with pnpm (`packageManager` in `package.json`).

| Command                | What it does                                                                 |
| ---------------------- | ---------------------------------------------------------------------------- |
| `pnpm dev`             | Nuxt dev server (DB in `.data/app.db`)                                       |
| `pnpm build`           | `.output/` plus the production launcher `.output/launcher.mjs`               |
| `pnpm start`           | Run the build the way the container does                                     |
| `pnpm test`            | All Vitest projects                                                          |
| `pnpm test:unit`       | Plain-TS tests (`app/utils`, `shared`, `server`, `test/unit`)                |
| `pnpm test:server`     | Builds, then drives the real server over HTTP (`test/server`); `TEST_SKIP_BUILD=1` reuses `.output/` |
| `pnpm test:e2e`        | Builds, then runs the Playwright browser journeys (`test/e2e`) against it; `TEST_SKIP_BUILD=1` reuses `.output/`. Needs Chromium once: `pnpm exec playwright install chromium` |
| `pnpm lint`            | `@nuxt/eslint`, including the module-boundary rules                          |
| `pnpm typecheck`       | `nuxt typecheck` (vue-tsc, incl. `tsconfig.spikes.json`)                     |
| `pnpm db:generate`     | Drizzle migration from `server/db/schema.ts` into `server/db/migrations/`    |
| `test/docker/smoke.sh` | Container smoke test for the `app` image (CI runs it)                        |
| `test/docker/restore-drill.sh` | Backup → restore drill from `docs/deploy/unraid.md` against the `app` image (CI runs it) |

Never edit a generated migration that has shipped; add a new one.

CI runs `pnpm audit --prod --audit-level high`. `pnpm.auditConfig.ignoreGhsas` in
`package.json` lists advisories in Nuxt's **build/dev-only** tooling
(`@nuxt/devtools` → simple-git, the `listhen` dev server → node-forge, braces)
that never reach `.output/` (check with `ls .output/server/node_modules`).
Ignore an advisory only after confirming that, and drop entries once Nuxt ships the fix.

## Releases

Releases are automatic. Every push to `main` that passes CI runs semantic-release
(`.releaserc.json`, the `release` job in `ci.yml`), so **commits on `main` must be
Conventional Commits**: `fix`/`perf` → patch, `feat` → minor, `!` or a
`BREAKING CHANGE:` footer → major; `docs`, `test`, `chore`, `ci`, `refactor`,
`build` and merge commits release nothing. A release tags the image that run tested
`X.Y.Z` / `X.Y` / `latest` first, then pushes the `vX.Y.Z` git tag and a GitHub
Release with generated notes (the Releases page is the changelog). Nothing is
committed back to `main`. `edge` is the unreleased tip of `main`. Never push a `v*`
tag by hand.

If a run pushed the git tag but failed to create the GitHub Release, a re-run won't
retry it; create it with `gh release create vX.Y.Z --generate-notes --verify-tag`.

## Status

M0 (spikes) is done. M1 (skeleton) is built: login with first-run setup code,
secret bootstrap, migrations, image + entrypoint, CI/GHCR, Unraid template.
The test install on the Unraid box is still open. M2 (rosters) is built:
players, regulars CRUD, `regulars.json` import, manual session players with
manual sightings, and the This week / Regulars / Players pages. M3 (TDF) is
built: the `shared/tdf` parser, preview → commit routes (the file travels as
JSON), `tdf` sightings for every player in the file, and the dropzone and
preview modal on This week. M4 (Pokémon connection) is built: token vault, paste-back
connect, `TokenProvider` with persist-before-use refresh, the hourly `pokemon:keepalive` task,
league discovery, and the Settings page with the reconnect banner. Server tests run against
`test/server/fake-pokemon.ts` through `NUXT_POKEMON_*_URL`. M5 (submission) is built: date → play-session
resolve in the league `TZ`, the plan → execute → reconcile job with a per-league lease, SSE progress,
History with retry/resume, and boot/shutdown handling. A 5xx from `_bulk` may still land a minute later,
so the job re-reads before resending (ADR-0004 update). M6 (metrics and curation) is built: metrics
computed on read from sightings in one SQL query, the Players page tabs (promotion candidates, stale
regulars, all), metrics on Regulars, thresholds in Settings (`curation_settings`), and "present" ticks
for regulars on This week. Next is M7 (hardening); see architecture §13. M8 (assign staff, #41) is designed in ADR-0007 (accepted); the gateway's tournament and staff methods (#45), the `staffing` module with its tables and staff routes (#46), the staff job that applies assignments to play-tools (#47), the Players → Staff tab with its inline rename (#50), the This week Staff card with its staff search and **Assign staff in play-tools** (#49), and Import staff from play-tools on Settings (#48, a read-only, unpaced `staff_import` job) are built. Spike S6 is done (fixtures in `server/modules/pokemon/adapters/play-tools/__fixtures__/s6/`) and its findings are in §4.3, §6.4 and ADR-0007. Multiple organizer logins (#66, ADR-0008) are built: one Pokémon connection per professor (player ID, with an optional display name set in Settings), each kept refreshed, the submitting professor chosen in Settings, recorded on every submission; migration 0009 carries the v1 connection over. Staff across professors (#75, ADR-0009) is built: This week lists every connected professor's tournaments, each read and staffed only as its organizer, and the league picker offers only leagues every professor shares. M9 (tournaments: templates, scaffolds and schedules, with "create through a date" in one click; create, cancel and reschedule; TDF results upload on This week) is designed in ADR-0010 and ADR-0011 (proposed, awaiting review); spike S8 part 1 (bundle) is done, and part 2 (live capture) must record fixtures before anything that writes upstream is built.
