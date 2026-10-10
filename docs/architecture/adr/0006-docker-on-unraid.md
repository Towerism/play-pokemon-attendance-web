# ADR-0006: Production deployment as a Docker container on Unraid

- Status: Accepted
- Date: 2026-10-10

## Context

ADR-0001 already ships the app as one Docker image. The production host is now
known: the organizer's **Unraid** server. Unraid runs containers from the
Docker tab using **templates**, which are XML files that turn ports, paths and
variables into form fields. People there expect to fill in a form, click
*Apply* and open the WebUI. They don't expect to run a shell, write a compose
file or generate keys.

So deployment has to be **painless on Unraid**, and that includes getting the
play-tools credential working. That credential is the Pokémon refresh token
(ADR-0003). The app gets it through the in-app connect flow, so there is no
PTC username or password to configure.

Unraid-specific facts that shape the design:

- Persistent data lives under `/mnt/user/appdata/<app>`. It is often backed up
  by the *Appdata Backup* plugin, which stops the container and archives the
  folder.
- Unraid's default owner for share data is `nobody:users` (UID 99, GID 100).
  Containers that run as root leave root-owned files that are a pain to manage
  over SMB.
- Unraid adds `TZ` to every container. The keep-alive cron and the meaning of
  "session date" both depend on local time.
- Template variables are stored **in plain text** on the USB flash
  (`/boot/config/plugins/dockerMan/templates-user/`) and show up in
  `docker inspect`. A masked field hides the value in the form only.
- People usually reach apps on the LAN over **plain HTTP** (`http://tower:3000`).
  Remote access, when it exists, goes through a reverse proxy (SWAG, Nginx
  Proxy Manager) or Tailscale.
- Updates come from Unraid checking the image tag's digest ("update ready").

## Options considered

1. **Unraid Docker template + a published multi-arch image on GHCR, with zero
   required settings.** Secrets are generated on first boot and persisted in
   appdata. The organizer account and the Pokémon connection are set up in the
   web UI.
2. **The same template, but with required secret variables**
   (`NUXT_SESSION_PASSWORD`, `NUXT_TOKEN_VAULT_KEY`) the user has to generate
   (`openssl rand …`) and paste in. This is the twelve-factor norm. On Unraid
   it adds a shell step, and the values end up in plain text on the flash
   anyway.
3. **Docker Compose** (Unraid *Compose Manager* plugin). Fine for people who
   know compose, but it needs a plugin and a YAML file. It is not the native
   Unraid flow.
4. **Unraid VM or plugin (not a container).** Far more work, and it is not
   how Unraid apps are distributed today.

## Decision

Option 1. Docker on Unraid is the **primary production target**. The same
image keeps working with `docker run` or compose on any host, but Unraid is
what we design, document and test for.

### Image

- Published to **GHCR** by CI as `ghcr.io/<owner>/play-pokemon-attendance`,
  multi-arch (`linux/amd64`, `linux/arm64`). Tags: `latest` (stable),
  `X.Y.Z`, `X.Y`.
- Multi-stage build. pnpm builds `.output/`, and the runtime stage is
  `node:22-slim` with the prebuilt `better-sqlite3` native module and the
  `litestream` binary. No build tools ship in the final image.
- One port, **`3000`**. One volume, **`/data`**. Everything persistent lives
  under it:

  ```
  /data/
    app.db, app.db-wal, app.db-shm     SQLite (ADR-0002)
    secrets/
      session-password                 generated on first boot, mode 0600
      token-vault.key                  generated on first boot, mode 0600
  ```

- **`PUID` / `PGID` / `UMASK`**, defaulting to `99` / `100` / `022` (Unraid's
  `nobody:users`). A small entrypoint fixes ownership of `/data` and then drops
  privileges with `gosu`. The Node process never runs as root.
- A `HEALTHCHECK` on `GET /healthz`, so the Docker tab shows health.
- It honours `TZ`. The keep-alive cron and "today's session date" use it.
- **Graceful shutdown.** On `SIGTERM` the app stops taking new submission
  batches, marks running jobs `interrupted` (they resume on boot, per
  ADR-0004), checkpoints the WAL and closes SQLite. The default 10 s stop
  timeout is enough. This keeps *Appdata Backup* snapshots consistent.

### Configuration: nothing required

Every template field is optional. An install with no changes works on the LAN.

| Variable                 | Default                         | Purpose                                                                                     |
| ------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------- |
| `PUID` / `PGID` / `UMASK`| `99` / `100` / `022`            | File ownership in appdata                                                                   |
| `TZ`                     | set by Unraid                   | Session dates, keep-alive schedule                                                          |
| `NUXT_PUBLIC_SITE_URL`   | derived from the request        | Set it when the app sits behind a reverse proxy, so links and the cookie `Secure` flag are correct |
| `NUXT_SESSION_PASSWORD`  | generated → `/data/secrets/`    | Override only to manage secrets yourself (masked field, *Advanced*)                          |
| `NUXT_TOKEN_VAULT_KEY`   | generated → `/data/secrets/`    | Same (masked field, *Advanced*)                                                              |
| `LITESTREAM_REPLICA_URL` + `LITESTREAM_ACCESS_KEY_ID` / `LITESTREAM_SECRET_ACCESS_KEY` | unset (off) | Optional off-box backup. When set, the entrypoint runs `litestream replicate -exec "node …"` |

An environment variable always wins over a generated file. Startup fails
loudly if a secret is malformed (wrong length or encoding), and never
silently regenerates one.

### Credentials: set up in the browser

- **Organizer login.** When there are no users, the app opens a **first-run
  setup** page to create the organizer account. To stop someone else on the
  LAN from claiming it first, setup needs a one-time **setup code** that is
  printed to the container log on boot (Docker tab → *Logs*). The code is
  invalid once an account exists.
- **Pokémon (play-tools) connection.** This uses the ADR-0003 connect flow, from
  *Settings → Connect Pokémon account*. It suits Unraid because the redirect
  goes to play-tools and the code comes back by paste or extension. **No
  inbound callback, public URL, port forward or TLS certificate is needed**, so
  it works on a LAN-only box. The refresh token is encrypted with the vault key
  and stored in SQLite. No PTC username or password is ever entered into the
  template or the app.
- **The manual access-token fallback** (ADR-0003 option 1) stays in the UI under
  *Advanced*, never in the template.

### Distribution

- `deploy/unraid/play-pokemon-attendance.xml` is an Unraid template with icon,
  WebUI (`http://[IP]:[PORT:3000]/`), the port, the `/data` →
  `/mnt/user/appdata/play-pokemon-attendance` path, and the variables above.
  `Mask="true"` is set on secret fields, and *Advanced* hides the overrides.
- v1 install: add the template repo URL in the Docker tab's template
  repositories (or copy the XML into `templates-user/`), then *Add Container*.
  A Community Applications listing can come later and doesn't change the image.
- `docs/deploy/unraid.md` is a one-page guide with screenshots: install, first
  run, connect Pokémon, optional Litestream, restore from backup, update.

## Consequences

- (+) Install is about four form clicks. Nothing needs a shell, and nothing
  needs to be generated, copied or pasted except the Pokémon connect step, which
  happens once.
- (+) A one-folder appdata layout works with *Appdata Backup*. Litestream is an
  optional extra, not a requirement.
- (+) The same image runs anywhere Docker runs, so moving off Unraid needs no
  change.
- (−) **The vault key sits on the same volume as the ciphertext by default.**
  Encryption at rest then protects the token in any copy of the DB without
  `secrets/`: Litestream replicas (which only ship the DB file), a shared or
  exported `app.db`, a bug report. It does **not** protect against someone who
  can read the whole appdata folder. On Unraid that person can also read the
  flash and `docker inspect`, so an env-var key (option 2) wouldn't be any
  stronger. People who want separation can set `NUXT_TOKEN_VAULT_KEY` and keep
  it elsewhere.
- (−) If `secrets/` is lost, the damage is limited and easy to recover from.
  A lost vault key means one Pokémon reconnect. A lost session password logs
  everyone out. Attendance data is unaffected. Restore docs must say to restore
  `secrets/` together with the DB to avoid both.
- (−) **Plain HTTP on the LAN.** Session cookies are `Secure` only when the site
  is served over HTTPS (worked out from `NUXT_PUBLIC_SITE_URL` or
  `X-Forwarded-Proto` from a trusted proxy). On plain HTTP the organizer
  password crosses the LAN unencrypted. That's acceptable for a home LAN. Any
  access from outside the LAN must go through HTTPS (reverse proxy) or
  Tailscale, and the guide says so. HSTS is only sent over HTTPS.
- (−) The image carries a small entrypoint (PUID/PGID, secret bootstrap,
  optional Litestream supervision) that needs its own tests: shell-level or a
  container smoke test in CI.
- (−) Fly.io and similar hosts drop from "primary" to "should work". They aren't
  tested in CI.
