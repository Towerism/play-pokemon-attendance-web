# M0 spikes: runbook

Throwaway tooling for spikes S1–S5 ([architecture §12](../docs/architecture/README.md#12-spikes-before-building-timeboxed--1-day-total)).
The spikes need the organizer's own Pokémon Trainer Club login, so a person
has to run them. Record the results in [`docs/architecture/spikes.md`](../docs/architecture/spikes.md).

The code that outlives M0 is **not** in this folder: the port interfaces,
OAuth/PKCE helpers and wire schemas are under `server/modules/pokemon/`, and
the spikes import them.

## Setup

```sh
fnm use                      # Node 22.23.3 from .node-version (Nuxt 4 needs ≥ 22.12)
npx pnpm@10.18.2 install     # or `pnpm install` if pnpm works on your machine*
```

\* The corepack bundled with older Node 22 fails with `Cannot find matching keyid`.
Either use `npx pnpm@…` as above or run `npm i -g corepack@latest`.

## Safety rules

- Everything sensitive goes to `spikes/.secrets/`, which is gitignored and
  created with mode 0700/0600: tokens, the PKCE verifier, and raw responses
  that contain minors' names. **Never commit or paste anything from it.**
- Output that is printed or saved outside `.secrets/` shows only token
  fingerprints (sha256 prefixes) and claim *names*.
- All reads are spaced at least 1.5 s apart, and S4 writes at least 15 s apart.
  The scripts act only on your own league, at the volume you'd generate by hand.
- When you are done: `rm -rf spikes/.secrets`, and revoke the session in your
  PTC account if you like.

## Order of work

| Day | Step |
| --- | --- |
| 0 | **S1**, then **S5 + S3** straight away while the access token is fresh. Then **S4**. Run `pnpm spike:s2` once (first rotation). |
| 1, 2 | `pnpm spike:s2` (daily rotation) |
| 3 → 9 | Leave it alone: a ≥ 7-day idle gap, i.e. a week off with no keep-alive |
| 9 | `pnpm spike:s2`, then `pnpm spike:s2 report`. Optionally `pnpm spike:s2 probe-reuse` (last, because it may revoke the chain) |
| any | `pnpm spike:fixtures`, then fill in `spikes.md` and pin the `TODO(Sx)`s in `wire.ts` |

### S1: does paste-back work? `pnpm spike:s1 --mode loaded|blocked`

The script prints an authorize URL built with *our* PKCE verifier. Open it in
your normal browser and log in. Pokémon redirects to
`https://play-tools.pokemon.com/loggedIn?code=…&state=…`. Paste that whole
URL back, either at the prompt or later with
`pnpm spike:s1 resume '<url>'`. The script matches it to its attempt by
`state` and redeems the code. Use `--no-wait` to print several attempts up front,
one per mode.

This step can't be automated: the login page sits behind bot protection
(spikes.md F5). The pasted URL is safe to hand to whoever runs `resume`,
because the code is useless without the PKCE verifier kept in `.secrets/`.

Try the two capture modes **in this order** and record both:

1. **Loaded (`l`).** Let the play-tools page load normally, then copy the URL
   from the address bar. This is the UX we want. The play-tools SPA may try to
   redeem the code itself, or rewrite the URL. If the exchange fails with
   `invalid_grant`, that's what happened.
2. **Blocked (`b`).** Before opening the URL, open DevTools → Network →
   *Request blocking* (or right-click any request → *Block request domain*)
   and add `play-tools.pokemon.com`. Then log in. The redirect is blocked,
   and the address bar keeps the untouched `?code=` URL. Remove the block afterwards.

An attempt stays pending for 24 h and can be used once. Hydra's own code
lifetime starts at the redirect, so paste promptly. The result is saved to
`.secrets/s1-result.<mode>.json` (no secrets).

### S5 + S3: identity and play-session shapes (read-only). `pnpm spike:s3`

- **S5:** the script decodes the token(s), calls `https://me.pokemon.com/me`,
  and tries each candidate id against `core/users/{id}/activity_groups/`. It
  prints which source worked and your activity groups.
- **S3:** for the group, it records `play_sessions` for `active`, `scheduled`
  and `completed` (page size 5, two pages, to expose pagination), then
  attendance `records` for one completed session.
- Options: `--group <id>` (default: discovered, else the CLI's hardcoded group),
  `--session <id>`, `--user <id>`.
- **Manual check (2 min):** in play-tools with DevTools open, load the league
  dashboard and note the exact `play_sessions` request URL, especially any
  date-filter query parameters. If server-side date filters exist, §4.4 can
  drop client-side paging.

Every response is validated live against the *provisional* schemas in
`server/modules/pokemon/adapters/play-tools/wire.ts`. A ✗ just means
`wire.ts` needs updating from the raw file.

### S4: `_bulk` semantics (WRITES). `pnpm spike:s4 …`

1. In play-tools, create a **throwaway play session** for your league (e.g.
   a future date, titled "API test, delete me").
2. Run it with your own player id **and** one other consenting player id. The session creator already holds an organizer record, so your own id alone can only exercise the duplicate path:
   ```sh
   pnpm spike:s4 --group <groupId> --session <throwawaySessionId> --player <organizerId> --player <consentingOtherId> [--with-invalid]
   ```
   You must type the last 6 characters of the session id to proceed.
3. The script adds the player, adds them again (error, no-op, or a second
   record?), optionally sends a mixed valid + invalid batch (the partial-failure
   shape), then deletes every record that wasn't in its starting snapshot and
   checks that the session matches the snapshot.
4. Delete the throwaway session in play-tools.

### S2: refresh lifetime and rotation. `pnpm spike:s2`

Follow the schedule above. Each run refreshes once, writes the rotated
refresh token *before* doing anything else (the ADR-0003 rule), and appends
a fingerprint-only line to `.secrets/s2-ledger.jsonl`. `report` summarises:
always rotated?, access-token lifetime, and how long the chain has survived.

`probe-reuse` replays the previous (already rotated) refresh token, then
checks whether the current one still works. That shows whether Hydra revokes
the whole chain on reuse, which is why refresh must be serialized. Run it last,
because you may have to run S1 again afterwards.

### Fixtures: `pnpm spike:fixtures`

Copies `.secrets/raw/<kind>.<label>.json` into
`server/modules/pokemon/adapters/play-tools/__fixtures__/`, with:
- names, emails and birthdates redacted;
- player ids and GUIDs replaced with stable fakes.

A file is refused if any original id survives. `misc.*` captures (userinfo,
deletes) are never exported. **Read the generated files before committing.**

## Definition of done for M0

- [ ] `docs/architecture/spikes.md` has an answer and a decision for S1–S5.
- [ ] `wire.ts` has no `TODO(Sx)` left, and the candidate fields are narrowed to the real ones.
- [ ] `__fixtures__/` has at least one sanitized fixture per `FixtureKind`, and `pnpm test` shows **no todos** in `wire.contract.test.ts`.
- [ ] ADR-0003 status moves from *Proposed* to *Accepted* (or is amended, e.g. to the companion extension if S1 fails in both modes).
- [ ] `spikes/.secrets/` deleted.
