# ADR-0014: Shared platform code from `@towerism/selfhost-kit`

- Status: Accepted (2026-10-13, #128, first applied in #129; A2 in #130)
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

## Consequences

- (+) There is one copy of the security code. A fix lands once and reaches both apps by a version bump.
- (+) Each step has a narrow diff, a specific safety check and a one-PR rollback.
- (−) The kit's limiter refuses a `max`/`windowMs` that isn't a safe integer ≥ 1. Attendance builds its limiters lazily,
  so such a value reaching them by a path the launcher doesn't validate (`NITRO_`-prefixed names, whole-object JSON
  overrides, `pnpm dev`, or a `NUXT_` value of 2^53 or more) makes the rate-limited routes answer 500. Before, such a
  value disabled the limit, tightened it or simply worked, depending on the value. None of these paths is in the
  template. The ≥ 2^53 path is closed at startup by [selfhost-kit#22](https://github.com/Towerism/selfhost-kit/issues/22);
  the rest by A5, when the kit's guard builds the limiters at boot.
- (−) Until #126, a kit security fix waits for a manual bump.
- (−) The kit's own unit tests are the proof for the moved pieces. Attendance's server tests stay as the evidence that
  its wiring is right.
