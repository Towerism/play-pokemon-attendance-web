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
  professor, keyed by player ID (ADR-0008). Tournament calls are made as each tournament's organizer (ADR-0009).
- **Professor logins** (ADR-0015): the setup account is the `owner`; everyone else is a `professor`. Each connection
  belongs to the user who connected it, and a write to play-tools goes only through a connection the signed-in user
  holds, decided in one place: the pokemon module's `actingConnection`. Attendance goes in as whoever submits;
  undo and retry run as the professor the attempt ran as. The league names no professor: the owner picks its
  activity group from their own connections' leagues, and a professor sees the league only while their connection's
  `league_membership` is `member`.
- **Submission is plan → execute → reconcile**, diffed against upstream; never
  auto-delete upstream records (ADR-0004).
- **Metrics come from sightings, not submissions** (ADR-0005).
- **Production is a Docker container on Unraid** (ADR-0006). The install must stay
  painless: no required template fields, everything persistent under `/data`,
  PUID/PGID 99/100, honour `TZ`. Credentials (organizer login, Pokémon connect)
  are set up in the browser, never in the template.

Module rules (enforce, don't erode):

- `server/api/*` handlers are thin: one access guard from `server/utils/access.ts` (`requireMember`; `requireOwner`
  for owner-only routes; `requireActor` only for the waiting-room routes), validate with shared Zod schemas, call a
  module service with the actor, map errors. `test/unit/route-guards.test.ts` holds every route to its guard. The
  exceptions are the public auth routes, the public invite routes (`server/api/invites/*`, rate-limited per client
  before the body is read, ADR-0015 §6), and `server/api/integrations/v1/*`, which takes only an integration bearer
  token with the route's scope (`requireIntegrationToken(event, scope)`, ADR-0013, ADR-0015 §7); no other route may
  accept one.
- No code but the pokemon module's `actingConnection` turns a professor into a connection for a write to play-tools.
- `server/modules/*` are plain TS — no h3 or Nuxt imports.
- From `@towerism/selfhost-kit` (ADR-0014), modules take only the plain helpers on the ESLint allowlist, never
  `/nitro`; loggers, request ids, secrets and vaults are
  wired outside `server/modules` (`server/utils`, `server/plugins`, `server/bootstrap`) and injected. `app/` and `shared/` never import the kit.
- Modules talk only through each other's exported services, never each other's tables.
- `server/modules/messaging` (the Discord channel Genie long-polls, ADR-0015 §7) knows no feature: callers own their
  words, recipients and what a result means, from fixed templates. No route takes message text.
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
- Invite and reset-link secrets (ADR-0015 §6) are stored only as a SHA-256, never logged, and returned once. A link
  waiting for Genie is sealed by the message vault (`NUXT_MESSAGE_VAULT_KEY` / `/data/secrets/message-vault.key`),
  which only `server/modules/messaging` gets.
- Never persist TDF birthdates, and keep raw TDF files **only** in the encrypted TDF archive (ADR-0012,
  `server/modules/tdf-archive`): gzip, then AES-256-GCM with its own key (`NUXT_TDF_VAULT_KEY` /
  `/data/secrets/tdf-vault.key`), decrypted only in memory, no temp files. Only that module touches `tdf_file`
  or the TDF key. Birthdates never go in a column, log or API response other than the file download.
- Never store the organizer's PTC password; no headless-browser login.
- Keep outbound play-tools traffic human-scale: one bulk batch at a time, by default 20 players at least 10 s apart (ADR-0004 update; never more than 50 per batch).

## Toolchain

Node 24 (`.node-version`, exact; the Dockerfile pins the same version) with pnpm (`packageManager` in `package.json`).

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
`package.json` lists advisories in **build/dev-only** tooling that never reaches `.output/`
(check with `ls .output/server/node_modules`): Nuxt's (`@nuxt/devtools` → simple-git, the `listhen`
dev server → node-forge, braces). Drop these once Nuxt ships the fix.

Ignore an advisory only after confirming that.

## Releases

Releases are automatic. Every push to `main` that passes CI runs semantic-release
(`.releaserc.json`, which extends `@towerism/selfhost-kit/release-config`; the `release`
job in `ci.yml`, which calls the kit's reusable `app-release.yml`), so **commits on `main` must be
Conventional Commits**: `fix`/`perf` → patch, `feat` → minor, `!` or a
`BREAKING CHANGE:` footer → major; `docs`, `test`, `chore`, `ci`, `refactor`,
`build` and merge commits release nothing. `fix(security)` commits get their own
**Security** section in the notes, with an `Advisory: GHSA-…` trailer linked. The `image`
job (the kit's `app-image.yml`) builds the image once and publishes the image the container
tests ran. A release tags that image `X.Y.Z` / `X.Y` / `latest` first, then pushes the
`vX.Y.Z` git tag and a GitHub Release with generated notes (the Releases page is the
changelog). Nothing is committed back to `main`. `edge` is the unreleased tip of `main`.
Never push a `v*` tag by hand.

Both kit workflows are pinned by the same full commit SHA with a `# vX.Y.Z` comment. A kit
bump moves the SHA, its comment and `package.json`'s exact `@towerism/selfhost-kit` version
together, to the commit of that release's tag.

If a run pushed the git tag but failed to create the GitHub Release, a re-run won't
retry it; create it with `gh release create vX.Y.Z --generate-notes --verify-tag`.
