# ADR-0014: Shared platform code from `@towerism/selfhost-kit`

- Status: Accepted (2026-10-13, #128, first applied in #129; A2 in #130; A3 in #131; A4 in #132; A5 in #133; A6 in #134; A7 in #135)
- Date: 2026-10-13
- Amends: §3 (tech stack, module rules), §9 and §10, which described these pieces as attendance's own code
- Companion: [selfhost-kit ADR-0001](https://github.com/Towerism/selfhost-kit/blob/main/docs/architecture/adr/0001-share-as-a-package.md)
  (share as a package), [ADR-0005](https://github.com/Towerism/selfhost-kit/blob/main/docs/architecture/adr/0005-versioning-and-security-fixes.md)
  (versioning and security fixes), [ADR-0007](https://github.com/Towerism/selfhost-kit/blob/main/docs/architecture/adr/0007-migration.md)
  (the migration plan) and [ADR-0008](https://github.com/Towerism/selfhost-kit/blob/main/docs/architecture/adr/0008-testing-strategy.md)
  (which tests move)

## Context

Attendance's most security-sensitive code is generic: the setup code, the auth rate limiter, client-address
resolution behind trusted proxies, request ids, CSP and security headers, log redaction, the secret bootstrap,
the launcher, the vault and the container entrypoint. Tournament Genie, the second self-hosted app, needs the same
pieces. Two copies would drift, and a fix would have to be made twice. Leaving one copy unfixed is the risk.

The kit (`@towerism/selfhost-kit`, public on npm) holds one copy of these pieces, with its own known-answer and
contract tests. It was built to match attendance's behaviour.

## Options considered

1. **Keep attendance's own copy; only Genie uses the kit.** This leaves two versions of the security code, and
   attendance's copy stops getting the kit's fixes.
2. **Copy the kit's code into attendance.** This is the same drift with extra steps.
3. **Depend on the kit, moving piece by piece behind attendance's existing tests.** (Chosen.)

## Decision

1. Attendance depends on `@towerism/selfhost-kit`, **pinned to an exact version** (no `^`/`~`) while the kit is 0.x.
   A minor kit version may break its API.
2. The pieces move in the steps A1–A7 of kit ADR-0007 (tracked in #128), each through the characterization gate:
   - the local module becomes a re-export shim of the kit, and attendance's existing tests run unchanged against it;
   - the call sites switch to the kit;
   - the shim and the unit tests the kit now owns (kit ADR-0008) are deleted;
   - attendance keeps its server and container tests unchanged, as the integration evidence, and runs the kit's
     contract suites with its own configuration where they apply.
3. Any difference from today's behaviour is named in that step's PR. A kit gap is filed on the kit, not worked
   around with a local copy.
4. Module boundaries still hold. `server/modules/*` may import only plain helpers from the kit root (an ESLint
   allowlist), and never `@towerism/selfhost-kit/nitro`. Loggers, request ids, secrets and vaults are
   wired outside `server/modules` (`server/utils`, `server/plugins`, `server/bootstrap`) and injected. `app/` and `shared/` never import the kit; it is server-only.
5. **Security fixes reach attendance only through a version bump.** Until attendance has a Renovate config (#126) that
   proposes kit bumps on release and on advisories (kit ADR-0005 rule 4), the owner bumps by hand on each kit release
   or advisory.

A1 (#129) moved the setup code, the fixed-window limiter, client address and trusted proxies, request ids, and the
CSP/security headers (including `nuxt.config.ts`'s imports). The Nitro wiring around them
(`server/plugins/security-headers.ts`, `server/plugins/logging.ts`, `server/utils/rate-limit.ts`, `requireIntegrationToken`)
stays attendance's until A5.

A2 (#130) moved the logger and log redaction. The kit's `createLogger` hides only its base keys unless it is given
a redactor, so attendance configures both in one place, `server/logging/app-logger.ts`:
- `createRedactor({ extraKeys: ATTENDANCE_LOG_KEYS })` adds `birthdate`, `dateOfBirth`, `dob`, `content`, `payload` and
  the secrets' env names to the kit's base keys. That is exactly the set attendance hid before.
- `createAppLogger` always applies that redactor.

ESLint rejects the kit's `createLogger`/`createRedactor` anywhere else, and any direct `pino` import in server and
script code. In `app/` and `shared/`, which don't log, a pino import is left to review. Modules take the `Logger`
type and `silentLogger` from the kit root.

Two formatter differences from attendance's own code are accepted:
- the kit prints `String(msg)` where attendance printed `String(msg ?? '')`. This can't happen, because messages are
  always strings;
- for a logged `err` that is not an `Error` and has no string stack, the kit prints a non-string `type` as `Error`
  and a non-string `message` as empty, where attendance printed `String(...)` of each. The kit prints less, never
  more.

A kit API that builds its own logger when none is passed (`runLauncher`, A3) must be given `createAppLogger(...)`.

A3 (#131) moved the secret bootstrap, the runtime env and the launcher. `server/bootstrap/app-env.ts` holds only
attendance's configuration: `SECRETS` (the kit's `sessionPassword()` and two `aes256Key` specs with today's env names,
file names and log labels), the six rate-limit variables, and `RUNTIME_ENV`, which the launcher passes to the kit's
`prepareRuntimeEnv`. The launcher is the kit's `runLauncher`, given `logger: createAppLogger({ scope: 'startup' })`;
ESLint rejects a `runLauncher` call without it (an aliased import, a namespace call, options built elsewhere, or a later
spread overriding `logger` are review checks). `ATTENDANCE_LOG_KEYS` takes the secret names from `secretKeyNames(SECRETS)`: the same list.
An existing install's `secrets/` is pinned by a test that loads synthetic files and checks that nothing on disk changes.
One difference from attendance's own code is accepted: `NUXT_SESSION_COOKIE_SECURE` is now derived with the kit's
`isHttpsSite` (the site URL parses and its protocol is `https:`), the check HSTS already used, instead of a
"starts with `https:`" prefix test. They agree on every well-formed URL; for a malformed one, `https:` or `https://`
alone is no longer Secure and a URL with leading whitespace now is.

A4 (#132) moved the vault, merging attendance's two vault files (the cipher and the token adapter) into the kit's
`createVault` / `stringVault`. `server/bootstrap/vaults.ts` is configuration only: it names the two vaults (`token`,
`TDF`), so every message reads as before, and holds the exact kit calls kit ADR-0007 names, in one place that
`server/utils` and the tests share. The keys still reach it only from runtime config, through
`server/utils/pokemon.ts` (token) and `server/utils/tdf-archive.ts` (TDF), and the vaults are injected into the modules.
Modules take `Vault`, `StringVault` and `VaultError` from the kit root and nothing from `server/bootstrap` (ESLint;
module tests may build the real vaults there). The kit's wire format, key check and messages are identical to attendance's. The compatibility
evidence stays in CI: a corpus sealed by the pre-migration code (every AAD shape, the carried-over league-id form
included; empty, binary and 2 MiB plaintexts) opens with the kit, and kit-sealed blobs open with a pinned copy of
that code (`test/fixtures/vault-v1/`, `test/unit/vault-compat.test.ts`). Three differences are accepted, none
visible to an install:
- the kit refuses an empty AAD; every attendance AAD is non-empty by construction, and tests record each one;
- the kit opens a header-only blob (an empty plaintext) that attendance's code refused, even its own; attendance
  never seals an empty plaintext (refresh tokens are non-empty at the OAuth wire, TDF files are gzip output);
- `TokenVaultError` is gone: the kit's `VaultError` is thrown unwrapped, and no log or response shows its name.

A5 (#133) moved the Nitro wiring around the A1 pieces to the kit's `/nitro` adapters. Each file keeps its name and holds
only attendance's configuration:
- `server/middleware/json-only.ts` is `jsonOnly()`;
- `server/middleware/body-size.ts` is `bodySizeLimit({ maxBytes: 2 MiB, exempt: [the TDF preview] })`;
- `server/plugins/security-headers.ts` is `securityHeadersPlugin({ siteUrl })`;
- `server/plugins/logging.ts` is `requestLogPlugin({ logger: useLogger('app') })`, whose `http` and `app` children are the
  same loggers as before;
- `server/error.ts` is `jsonErrorHandler()`;
- login and setup call the kit's `enforceRateLimit(event, authRateLimit(route))`.

The limiters and trusted proxies are built once at boot by `server/bootstrap/rate-limits.ts`, called from
`server/plugins/0.rate-limits.ts`, which sorts and runs before every other attendance plugin. The integrations limiter is
built there too, but it keeps its own per-token check, because the kit guard keys by client address. Attendance runs the
kit's `describeJsonOnly`, `describeBodySize` and `describeSecurityHeaders` against its configuration
(`test/unit/kit-nitro-contracts.test.ts`), and every existing `test/server` file passed unchanged against the shim and
after. ESLint keeps `@towerism/selfhost-kit/testing` out of every non-test file it lints, except
`server/logging/app-logger.ts` (a known gap). Three differences are deliberate, and each fails closed:
- a POST/PUT/PATCH/DELETE under `/api` (except the TDF preview) sent with `Transfer-Encoding` and no `Content-Length`
  gets 411 before the route runs (the kit's K2 decision). It used to be read with no size cap. A chunked non-JSON body
  therefore gets 411 rather than 415, still before any handler. Browsers always send a length, and the TDF preview,
  which has always answered 411 without one, shows that the proxies installs use pass it on. A malformed length is still refused by Node's
  parser with 400, as before;
- a DELETE body over 2 MiB gets 413;
- a rate-limit or trusted-proxy value the kit refuses now fails startup (exit 1, a message naming the variables, before
  the database opens) instead of making the limited routes answer 500 (see Consequences).

A6 (#134) moved the container's Docker assets. The entrypoint, `litestream.yml` and the Litestream installer
(`fetch-litestream.sh`, the one Litestream pin) are the kit's, copied out of `node_modules` at build time by its
`selfhost-kit docker-assets` bin into `/opt/selfhost-kit` in the Dockerfile's `app-deps` stage, so the image always
carries the pinned kit version's bytes and there is no committed copy to keep in sync. `docker/` is gone. The entrypoint
lands at the same path and the config at `/etc/litestream.yml`, with the same env names, defaults, log lines and exit
codes; the unchanged `test/docker/smoke.sh`, `litestream.sh` and `restore-drill.sh` are the evidence. Attendance's
unit tests run against the bin's output and keep only its own contract with the entrypoint (the log lines the Unraid
guide quotes, the config path, a failing app's exit status); the entrypoint's behaviour tests are the kit's. Two
differences are deliberate:
- the kit 0.4.2 entrypoint re-owns a symlink under `/data` itself, never its target (`chown -h`,
  [GHSA-9hhq-6x36-4565](https://github.com/advisories/GHSA-9hhq-6x36-4565)). Attendance's own copy re-owned the target,
  which could be any file the container can see. Attendance never creates symlinks under `/data`;
- the kit's installer is amd64-only, so a local `app` build on an arm64 host needs `--platform linux/amd64`
  (ADR-0006, update A6). The published image has been amd64-only since M7.

A7 (#135) moved CI's image and release jobs to the kit's reusable `app-image.yml` and `app-release.yml`, both pinned by
the v0.4.2 commit's full SHA, and `.releaserc.json` to `{ "extends": "@towerism/selfhost-kit/release-config" }`. The
`check` and `e2e` jobs are unchanged; the image job runs the same three container tests in the same order on target
`app`; the release still waits for `check`, `e2e` and `image` on a push to `main`. The image job grants only
`contents: read` and `packages: write`, the release job `contents: write` and `packages: write`, and no secret is passed
(the kit uses `github.token`). The image name became an input to both calls (a reusable-workflow call can't read `env`),
so `test/unit/unraid-template.test.ts` now checks both inputs name the image the template pulls. Semantic-release dry runs
on synthetic commits give the same versions with both configs. Deliberate differences:
- the image is built once and the smoke-tested image is published, instead of a second build. `pr-N` and `sha-<short>`
  are a plain amd64 image manifest; `edge`, `X.Y.Z`, `X.Y` and `latest` are a one-entry manifest list around it
  ([selfhost-kit#30](https://github.com/Towerism/selfhost-kit/issues/30)), and no image carries a provenance
  attestation any more (ADR-0006, update A7);
- the container tests get the image as `app-image:smoke-test` and `/dev/null` as stdin;
- the kit's jobs run on `ubuntu-24.04` with 30/15-minute timeouts and SHA-pinned actions at newer majors;
- before tagging, the release checks that `main` is still at the run's commit, and afterwards that `vX.Y.Z` points at it;
- `fix(security)` commits get a **Security** section in the release notes, with their `Advisory: GHSA-…` linked;
- the checks show as "Image (smoke test, publish) / image" and "Release / release" (`main` has no required checks).

A4 is a pure refactor and releases nothing, departing from kit ADR-0007's "each step ships as its own release" in
favour of its "pure refactors release nothing"; a rollback is a revert PR. A7 is a pipeline change (`ci:` commits) and
releases nothing either: its effect on published images first reaches installs with the next `fix`/`feat` release, so
pinning the release before that one on Unraid undoes it for an install, and reverting A7 undoes it in CI.

## Consequences

- (+) There is one copy of the security code. A fix lands once and reaches both apps by a version bump.
- (+) Each step has a narrow diff, a specific safety check and a one-PR rollback.
- (−) The kit's limiter refuses a `max`/`windowMs` that isn't a safe integer ≥ 1. Such a value can reach runtime config
  by a path the launcher doesn't validate:
  - `NITRO_`-prefixed names;
  - whole-object JSON overrides;
  - `pnpm dev`;
  - a `NUXT_` value of 2^53 or more, until [selfhost-kit#22](https://github.com/Towerism/selfhost-kit/issues/22).

  Before the kit, such a value disabled the limit, tightened it or simply worked, depending on the value. From A1 to
  A4 it made the rate-limited routes answer 500. Since A5 the limiters are built at boot, so it **fails startup** with
  a message naming the variables. An install whose only bad value is the integrations limit loses the whole app until
  the value is fixed, not just the integrations reads. Failing closed and loudly is deliberate. None of these paths is
  in the template.
- (−) Until #126, a kit security fix waits for a manual bump.
- (−) The kit's own unit tests are the proof for the moved pieces. Attendance's server tests stay as the evidence that
  its wiring is right.
