# Running on Unraid

How to install, configure, back up and restore the attendance app on an Unraid
server, and how to prove that the backups work. The design behind it is
[ADR-0006](../architecture/adr/0006-docker-on-unraid.md) and
[architecture §10](../architecture/README.md#10-deployment-and-operations).

Everything the app keeps lives in one appdata folder,
`/mnt/user/appdata/play-pokemon-attendance`, mounted in the container at `/data`:

| Path in the container | What it is | Notes |
| --- | --- | --- |
| `/data/app.db` (plus `app.db-wal`, `app.db-shm`) | The SQLite database: regulars, players, sightings, submission history, settings | Back up and restore the three files together |
| `/data/secrets/session-password` | Signs login cookies | Generated on first boot, mode 0600. Absent if you set `NUXT_SESSION_PASSWORD` |
| `/data/secrets/token-vault.key` | Encrypts the saved Pokémon login | Generated on first boot, mode 0600. Absent if you set `NUXT_TOKEN_VAULT_KEY` |
| `/data/secrets/tdf-vault.key` | Encrypts the stored tournament files (`.tdf`), which hold players' birthdates (ADR-0012) | Generated on first boot, mode 0600. Absent if you set `NUXT_TDF_VAULT_KEY` (env only, not in the template). **Losing it loses the stored files** |

## Install

No field in the template is required, and you never type a password into it.

1. **Add the template.** On the *Docker* tab, open *Template repositories*, add
   `https://github.com/Towerism/play-pokemon-attendance-web` and save. (Or copy
   [`deploy/unraid/play-pokemon-attendance.xml`](../../deploy/unraid/play-pokemon-attendance.xml)
   into `/boot/config/plugins/dockerMan/templates-user/`.)
2. **Create the container.** *Add Container* → pick **play-pokemon-attendance** →
   *Apply*. The defaults are fine for use on your LAN.
3. **Find the setup code.** *Docker* tab → click the container's icon → *Logs*.
   Look for this line (your code differs):

   ```text
   [2026-10-10 19:03:22.123] INFO: [setup] No organizer account yet. Open the app and enter this setup code: ABCD-2345
   ```

   The code is printed on every start until an account exists, and is useless
   after that. It stops someone else on your network from claiming the app first.
4. **Create the organizer account.** Open the WebUI (`http://tower:3000`, or
   your server's name or IP), enter the setup code, and choose a username and
   password.
5. **Connect your Pokémon account.** *Settings* → *Connect Pokémon account*. Log
   in on Pokémon's own page, then bring the code back to the app as the page
   explains ([how the code comes back](../architecture/README.md#42-capturing-the-authorization-code)).
   Pick your league if the app asks. The app keeps the login fresh by itself
   from then on.

Then set up backups (see [Backup](#backup)) before the first league night.

## Configuration

Every field below is optional. The ones marked *Advanced* are under *Show more
settings* when you edit the container.

| Template field | Target | Default | When to change it |
| --- | --- | --- | --- |
| WebUI port | `3000` | `3000` | Port 3000 is taken on the server |
| App data | `/data` | `/mnt/user/appdata/play-pokemon-attendance` | You keep appdata somewhere else |
| Site URL (*Advanced*) | `NUXT_PUBLIC_SITE_URL` | empty | Only when the app sits behind an HTTPS reverse proxy (see [Remote access](#remote-access)) |
| PUID (*Advanced*) | `PUID` | `99` (nobody) | The appdata share belongs to another user |
| PGID (*Advanced*) | `PGID` | `100` (users) | The appdata share belongs to another group |
| UMASK (*Advanced*) | `UMASK` | `022` | You want new files less readable |
| Session password (override) (*Advanced*) | `NUXT_SESSION_PASSWORD` | empty: generated into `secrets/` | You want to manage it yourself (at least 32 characters) |
| Token vault key (override) (*Advanced*) | `NUXT_TOKEN_VAULT_KEY` | empty: generated into `secrets/` | You want the key kept off the appdata volume (32 bytes, base64) |
| Litestream replica URL (*Advanced*) | `LITESTREAM_REPLICA_URL` | empty: off | You want off-box backups (see [Litestream](#optional-litestream-off-box-backup)) |
| Litestream access key ID (*Advanced*) | `LITESTREAM_ACCESS_KEY_ID` | empty | With the replica URL |
| Litestream secret access key (*Advanced*) | `LITESTREAM_SECRET_ACCESS_KEY` | empty | With the replica URL |
| Trusted proxies (*Advanced*) | `NUXT_TRUSTED_PROXIES` | empty: loopback and Docker networks | Your reverse proxy runs on `br0` or another machine (see [Remote access](#remote-access)) |

Unraid sets `TZ` for every container. The app uses it for "today's" session
date and for the hourly Pokémon keep-alive, so keep Unraid's time zone right.

Two overrides need care:

- If you set *Session password* or *Token vault key* yourself, keep a copy in a
  password manager. They live in the template (stored in plain text on the flash
  drive), not in appdata, so an appdata backup does not contain them. A
  malformed value stops the container at startup; it is never silently replaced.
- Never set `NUXT_POKEMON_ACCESS_URL` or `NUXT_POKEMON_API_URL`: they exist only to point the app at a fake Pokémon server in tests.

## Remote access

Plain HTTP (`http://tower:3000`) is for your home network only: the organizer
password crosses the network unencrypted. To use the app from outside, choose one:

- **An HTTPS reverse proxy** (SWAG, Nginx Proxy Manager) that forwards to port
  3000. Set *Site URL* to the public address, for example
  `https://attendance.example.com`, so login cookies are marked `Secure` and
  links point at the right place.
- **Tailscale.** Reach the server over your tailnet. Leave *Site URL* empty
  unless you serve the app over HTTPS there too.

Don't forward port 3000 on your router.

With an `https://` *Site URL*, login cookies are `Secure`, and a browser never
sends them back over plain HTTP. Logging in at `http://tower:3000` then fails:
the login page just comes back. Either use the HTTPS address, or clear *Site URL*
for LAN-only use.

Login is limited to 10 attempts per 15 minutes for each visitor (first-run setup
to 5). Behind a proxy, the app tells visitors apart by the `X-Forwarded-For`
header the proxy adds, and believes that header only from addresses in
*Trusted proxies* (`NUXT_TRUSTED_PROXIES`). Left empty, that covers the server
itself and Docker's networks (`127.0.0.0/8`, `::1` and `172.16.0.0/12`), which
is where Caddy, SWAG or Nginx Proxy Manager sit when they run as containers on
the same Unraid box. Set it to the proxy's exact address when:

- the proxy runs on `br0` with its own LAN address, or on another machine, for
  example `NUXT_TRUSTED_PROXIES=192.168.1.5`. Until you do, all visitors through
  that proxy share one limit.
- Docker hides visitors' real addresses behind its gateway (rootless Docker, or
  the userland proxy). Then a computer on your network looks like a Docker
  address and could fake the header, so trust only the proxy:
  `NUXT_TRUSTED_PROXIES=172.18.0.5` (your proxy container's address).

Use `none` when there is no proxy at all. Separate several entries with commas;
ranges such as `10.0.0.0/24` work too. A value the app can't read stops the
container at startup, and the log names the bad entry.

## Updates

- When a new release is out, the *Docker* tab shows *update ready* for the
  container. Click it to pull the new image. Database migrations run by
  themselves on startup.
- Take a backup first: a migration can't be undone, and an older image does not
  run against a newer database.
- `:latest` follows releases. To choose when you upgrade, set the container's
  *Repository* to a version tag instead: `X.Y` (gets fixes) or `X.Y.Z` (fixed).
- To try a pull request, set *Repository* to
  `ghcr.io/towerism/play-pokemon-attendance:pr-<number>`. A PR can
  add migrations that no release has yet, so only try it in a second container on
  a **copy** of appdata (set it up like the [restore drill](#restore-drill)), and
  never on your live folder.

## Backup

Back up the **whole appdata folder**: the database and `secrets/` together.
`secrets/` plus `app.db` can decrypt your saved Pokémon login, so keep backups
somewhere only you can read. The app also keeps every `.tdf` you drop, encrypted
in `app.db` with its own key (ADR-0012). The same backup holds that key
(`secrets/tdf-vault.key`) next to the encrypted files, so anyone with the backup
can open every stored TDF, players' birthdates included, and many players are
minors. Encryption protects a copy of `app.db` on its own and the Litestream
replica, not an appdata backup.

### Appdata Backup plugin (recommended)

Install *Appdata Backup* from the *Apps* tab, include this container, and give it
a schedule (nightly is plenty). The plugin stops the container, archives its
appdata folder and starts it again, so the copy is consistent. The app shuts down
cleanly within Docker's 10 s stop timeout.

### Manual archive (fallback)

On the Unraid terminal (adjust the backup path to a share of yours):

```sh
docker stop play-pokemon-attendance
tar -C /mnt/user/appdata/play-pokemon-attendance -cpf /mnt/user/backups/play-pokemon-attendance-$(date +%F).tar .
chmod 600 /mnt/user/backups/play-pokemon-attendance-*.tar
docker start play-pokemon-attendance
```

`-p` keeps file permissions, so `secrets/` stays 0600 inside the archive.

### Optional: Litestream off-box backup

Litestream continuously copies the database to an S3-compatible bucket (Backblaze
B2, Cloudflare R2, AWS S3, MinIO). It costs cents a month and covers you if the
server itself is lost. It is off until you set the replica URL.

1. Create a bucket and an access key limited to it.
2. Edit the container and fill the three *Advanced* fields:
   - `LITESTREAM_REPLICA_URL`: the bucket and a path, plus the provider's endpoint,
     for example `s3://<your-bucket>/attendance?endpoint=https://s3.<region>.backblazeb2.com`
   - `LITESTREAM_ACCESS_KEY_ID`: the key ID
   - `LITESTREAM_SECRET_ACCESS_KEY`: the secret (a masked field)
3. *Apply*. The log now shows where the database is being copied (credentials and
   the query string are left out):

   ```text
   [entrypoint] litestream: replicating /data/app.db to s3://<your-bucket>/attendance
   ```

What to expect:

- **Only `app.db` is replicated.** `secrets/` never leaves the server, so keep
  the Appdata Backup (or manual archive) running as well: it is where `secrets/`
  comes from on a restore.
- If the keys are set but the URL is empty, the log says
  `backups are off` and the app runs without Litestream.
- A replica URL Litestream can't use (unknown scheme, bad config) stops the
  container at startup with Litestream's error in the log. Running without the
  backups you asked for is treated as worse than not running.
- With a database already in place, a bucket that is unreachable later only
  produces sync errors in the log; the app keeps working and Litestream catches
  up when the bucket is back.
- When `app.db` is **missing** at startup, the container first restores it from
  the replica (see [Restore](#restore)). A normal restart never restores.

## Restore

**Always restore `secrets/` together with `app.db`.** If one of them is lost:

- A lost token vault key means one Pokémon reconnect in *Settings*: the saved
  login can't be decrypted any more. No attendance data is lost.
- A lost **TDF vault key loses the stored tournament files**: a new key is
  generated, and the old files can't be opened with it (they can still be
  listed and deleted). play-tools still holds any results you uploaded, and
  attendance, regulars and history are unaffected.
- A lost session password logs everyone out: sign in again. No attendance data
  is lost either.
- A lost database with `secrets/` intact is a fresh install: the setup code is
  printed again, and regulars and history are gone unless Litestream has them.

The saved Pokémon login in a backup is as old as the backup. The app renews it
every hour, and Pokémon revokes the login when an older copy is used, so after
restoring a backup more than about an hour old expect *Settings* to ask you to
reconnect once.

Restore only onto the same image version or newer. Migrations move forward on
startup; there is no way back to an older image over a newer database.

### From Appdata Backup or a manual archive

1. Stop the container (*Docker* tab → *Stop*).
2. Move the current folder aside rather than deleting it:
   `mv /mnt/user/appdata/play-pokemon-attendance /mnt/user/appdata/play-pokemon-attendance.before-restore`
3. Restore the archive into `/mnt/user/appdata/play-pokemon-attendance`, with the
   Appdata Backup plugin's restore page or on the terminal:

   ```sh
   mkdir /mnt/user/appdata/play-pokemon-attendance
   tar -C /mnt/user/appdata/play-pokemon-attendance -xpf /mnt/user/backups/play-pokemon-attendance-YYYY-MM-DD.tar
   ```

   If the archive fails to extract, treat that backup as broken and use an older one.
4. Start the container. File ownership is fixed for `PUID:PGID` on startup, so
   there is nothing to `chown` by hand.
5. Check the log shows no setup code, log in, and look at *Regulars* and
   *History*. Delete the `.before-restore` folder once you are happy.

### From Litestream

Use this when the database is lost or corrupt, or on a new server.

1. Stop the container.
2. In the appdata folder, move `app.db`, `app.db-wal` and `app.db-shm` aside.
   Put `secrets/` from your latest appdata backup in place (on a new server,
   restore the archive first and then remove its `app.db*` files).
3. Start the container with the same three Litestream fields. Because `app.db`
   is missing, the container runs `litestream restore` before the app starts,
   and the log says:

   ```text
   [entrypoint] litestream: restored /data/app.db from replica
   ```

If it doesn't go that way:

- `litestream: no replica found, starting with an empty database` means the URL
  points at an empty place. The app is now running empty and printing a setup
  code: stop it, fix the URL, remove the new `app.db*` files and start again.
  Don't enter the setup code.
- If the bucket can't be reached (network down, wrong endpoint or keys), the
  restore retries for about 4 minutes before the container stops with an error.
  Fix the cause and start it again.
- Don't get around a failed restore by clearing the Litestream fields: an empty
  folder then becomes a fresh install with a new setup code. Restore the appdata
  backup instead.

## Restore drill

A backup that has never been restored is a hope, not a backup. Run this drill
**before each league season**, and again after any change to your backup setup.
It restores a backup into a second, throwaway container and leaves the live one
running untouched. (CI runs the same restore steps against every image build, in
`test/docker/restore-drill.sh`; this drill checks *your* backups.)

**Keep the drill away from Pokémon.** The drill container holds a copy of the
saved Pokémon login, and Pokémon revokes the login everywhere when an older copy
is used. If the drill container renews it, your live app needs a reconnect. So:

- Start the drill just after the top of the hour and remove the drill container
  before the next one: the app renews the login on the hour.
- In the drill container, don't press *Connect*, *Reconnect*, *Disconnect*,
  *Submit*, *Retry* or *Resume*, and don't change the league.

Steps:

1. **Pick the backup**: the newest Appdata Backup archive or manual `tar`.
2. **Restore it into a drill folder** on the Unraid terminal:

   ```sh
   mkdir /mnt/user/appdata/play-pokemon-attendance-drill
   tar -C /mnt/user/appdata/play-pokemon-attendance-drill -xpf /path/to/backup.tar
   ```

   A failed extract means a failed backup: stop here and fix your backups.
3. **Create the drill container.** *Docker* tab → *Add Container* → template
   **play-pokemon-attendance**, then change:
   - *Name*: `play-pokemon-attendance-drill`
   - *WebUI port*: `3100`
   - *App data*: `/mnt/user/appdata/play-pokemon-attendance-drill`
   - the three Litestream fields: **leave empty**, so the drill never writes to
     your live replica
   - *Session password* / *Token vault key*: copy them from the live container
     only if you set them there

   Then *Apply*.
4. **Check it** (all must hold):
   - [ ] The *Docker* tab shows the drill container as healthy.
   - [ ] Its log has **no** setup code line.
   - [ ] You can log in at `http://tower:3100` with your organizer password.
   - [ ] *Regulars* shows the regulars you expect.
   - [ ] *History* shows your most recent submissions up to the backup date.
   - [ ] *Settings* shows the Pokémon account as connected, as on the live app.
   - [ ] `http://tower:3100/api/tdf-files` lists the tournament files you
     imported, and `http://tower:3100/api/tdf-files/<id>/download` downloads one
     that opens in a text editor. A `409` there means `secrets/` didn't come
     back with `app.db`.
5. **Tear it down** before the hour is up: *Docker* tab → drill container →
   *Stop*, then *Remove*. Then delete the drill folder:

   ```sh
   rm -rf /mnt/user/appdata/play-pokemon-attendance-drill
   ```

6. **Write it down**: the date, which backup you used, and whether every check
   held. If one didn't, your backups are not working yet; fix that before you
   rely on them.

## Troubleshooting

**There is no setup code in the log.** An organizer account already exists, so
setup is closed. Log in at the WebUI instead. If this is a new install and you
expected a fresh start, the *App data* path points at an old folder.

**Permission errors on the appdata folder** (`EACCES`, files you can't edit over
SMB). The container makes every file belong to `PUID:PGID` at startup (`99:100`,
Unraid's `nobody:users`, by default). Check that those match the share's owner,
then restart the container. Don't run the container with a custom `--user`.

**The container is unhealthy or keeps stopping.** Open its log; the last lines
say why. The usual causes:

- A malformed secret override:
  `Invalid secret in env var NUXT_TOKEN_VAULT_KEY: … Fix or remove it; it is never regenerated automatically.`
  Correct the value, or clear the field to use the generated file.
- Litestream can't start or can't restore (see [Litestream](#optional-litestream-off-box-backup)
  and [From Litestream](#from-litestream)).

**Login keeps returning to the login page behind a proxy.** *Site URL* doesn't
match the address in your browser. With an `https://` *Site URL* you must use
that HTTPS address; for `http://tower:3000` leave *Site URL* empty (see
[Remote access](#remote-access)).

**A banner says "Pokémon no longer accepts the saved login".** Go to *Settings* →
*Reconnect* and log in on Pokémon's page again. This is expected after restoring
an older backup or losing the token vault key, after a drill container renewed the
login, or after you changed your Pokémon password. Attendance already entered in
the app is not lost.
