# Play! Pokémon league attendance

A web app for entering Play! Pokémon league attendance into play-tools:
curated regulars, per-date session players, `.tdf` import and one-click,
idempotent submission. It replaces the
[play-pokemon-attendance CLI](https://github.com/Towerism/play-pokemon-attendance).

Design: [`docs/architecture/`](docs/architecture/README.md).

## Install on Unraid

1. Docker tab → *Template repositories*: add
   `https://github.com/Towerism/play-pokemon-attendance-web`. Or copy
   [`deploy/unraid/play-pokemon-attendance.xml`](deploy/unraid/play-pokemon-attendance.xml)
   into `/boot/config/plugins/dockerMan/templates-user/`.
2. *Add Container* → pick **play-pokemon-attendance** → *Apply*. No field is required.
3. Open the WebUI. Enter the setup code from the container's log
   (Docker tab → container → *Logs*) to create the organizer account.

Everything persistent lives in `/mnt/user/appdata/play-pokemon-attendance`. Back
up the whole folder, and always restore `secrets/` together with `app.db`.

The [Unraid guide](docs/deploy/unraid.md) covers configuration, remote access,
updates, backups (Appdata Backup, optional Litestream), restore, and a restore
drill to run before each season.

To try a pull request, set the container's *Repository* to
`ghcr.io/towerism/play-pokemon-attendance:pr-<number>` (amd64 only; CI publishes
it for PRs opened from this repo, and refreshes it on every push to the PR).
Switch back to `:latest` afterwards; a PR may add migrations that a release
does not have yet, so test against a copy of appdata.

Any other Docker host works too: `docker compose up -d app`, then
`docker compose logs app` to get the setup code.

## Develop

```sh
pnpm install
pnpm dev        # http://localhost:3000
pnpm test       # unit tests, plus the built server driven over HTTP
pnpm lint && pnpm typecheck
```

See [CLAUDE.md](CLAUDE.md) for the full command list and the working rules (TDD, module boundaries, security).
