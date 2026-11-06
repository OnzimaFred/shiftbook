# Deploying Shiftbook on DigitalOcean with Cloudflare

Everything runs on one droplet with Docker Compose. There are four containers:

| Container | What it does |
|---|---|
| `db` | Postgres 16. Only reachable by the other containers, never from the internet. |
| `app` | The Shiftbook API and app (Node.js). Applies database migrations each time it starts. |
| `backup` | Makes a database dump and a photo archive every day, and keeps 14 days of them in `./backups`. |
| `tunnel` | Optional. A Cloudflare Tunnel, so the droplet needs no open web ports. |

A $6/month droplet (1 GB RAM) is enough for two plants. Ubuntu 24.04 with Docker installed is the simplest starting point.

## Quick start (about 15 minutes)

1. **Cloudflare:** Zero Trust → Networks → Tunnels → Create a tunnel (Cloudflared). Copy its token. Under Public hostname, add `shiftbook.yourdomain.com` → HTTP → `app:8080`.
2. **Copy the folder to the droplet.** From PowerShell on your PC, in the folder that holds Shiftbook:
   ```
   scp -r .\Shiftbook root@<droplet-ip>:/opt/shiftbook
   ```
3. **Install and start:**
   ```
   ssh root@<droplet-ip>
   cd /opt/shiftbook && sudo bash scripts/install.sh
   ```
   It installs Docker if needed, asks for the address and the tunnel token, makes the database passwords, builds and starts everything.
4. **Create your sign-in:** `sudo bash scripts/create-manager.sh`. It prints a temporary password. Open the address, sign in, and choose your own.

The sections below explain the same steps in detail, and the reverse-proxy alternative.

## 1. Put the files on the droplet

```
ssh root@<droplet-ip>
mkdir -p /opt/shiftbook && cd /opt/shiftbook
# copy this folder here (git clone, scp or rsync)
cp .env.example .env
nano .env
```

Fill in `.env`:
- **`APP_ORIGIN`**: the address staff will open, for example `https://shiftbook.yourdomain.com`. Passkeys are tied to this address, so choose it before anyone sets up their phone.
- **`DB_OWNER_PASSWORD`** and **`API_DB_PASSWORD`**: two different long passwords. Make each with `openssl rand -base64 30`.

## 2. Choose how Cloudflare reaches the app

### Option A: Cloudflare Tunnel (recommended)

The droplet opens no web ports at all. Cloudflare connects out to it.

1. In Cloudflare, go to **Zero Trust → Networks → Tunnels → Create a tunnel** (choose Cloudflared) and copy the token into `CLOUDFLARE_TUNNEL_TOKEN` in `.env`.
2. In the tunnel's **Public hostname** settings, add `shiftbook.yourdomain.com` with service type **HTTP** and URL **`app:8080`**.
3. Start everything: `docker compose --profile tunnel up -d --build`

### Option B: your existing reverse proxy

Use this if the droplet already runs Nginx, Caddy or Traefik for your other apps. The app listens only on `127.0.0.1:8080` (change it with `APP_PORT`).

1. Point your proxy at `http://127.0.0.1:8080` for `shiftbook.yourdomain.com`.
2. In Cloudflare DNS, add an **A record** for `shiftbook` pointing at the droplet, with the orange cloud (proxied) on.
3. Set **SSL/TLS → Full (strict)**, and use a Cloudflare Origin Certificate on your proxy.
4. Start it: `docker compose up -d --build`

### Cloudflare settings for both options
- **SSL/TLS:** Full (strict). Turn on **Always Use HTTPS**.
- **Caching:** leave the defaults. Cloudflare doesn't cache `/api/` responses, which are JSON and set no cache headers.
- **Optional:** a WAF rate-limiting rule on `/api/auth/login`. The app already limits each address to 10 tries a minute.

## 3. Check it's running

```
docker compose ps                    # all containers "healthy" or "running"
docker compose logs -f app           # shows "Applied 0000_platform.sql" ... on first start
curl -s https://shiftbook.yourdomain.com/api/health     # {"ok":true}
```

## 4. Create the first Plant Manager sign-in

Pick a temporary password, run this once, then sign in and choose a real password:

```
docker compose exec db psql -U shiftbook_owner shiftbook -c \
  "update staff set user_id = auth.create_user('plant.manager', 'temporary-pass-123'), full_name = 'Real Name Here'
   where designation = 'plant_manager';"
```

From the app, the Plant Manager then:
- **Staff:** fills in the real names of the shared positions, creates everyone else's sign-ins, and hands each person their temporary password in person.
- **Settings → Plant boundaries:** stands in each power house and presses "Use my location".
- **Settings → Control-room phones:** signs in on the control-room phone itself and presses "Make this phone the control-room phone". The phone signs the manager out and shows the clock-in code from then on. Plug it in and leave it on the stand.
- **Approvals:** approves each person's phone after they set up their fingerprint, with the person standing there.

Each person then signs in on their own phone, chooses a password, sets up their fingerprint and a control-room PIN in Settings, and adds Shiftbook to their home screen (Chrome menu → "Add to Home screen").

Passkeys only work on the final https address. If you change the domain later, everyone sets up their fingerprint again.

## 5. Updates

```
cd /opt/shiftbook
git pull                             # or copy the new files over
docker compose up -d --build         # new database migrations apply automatically
```

## 6. Backups

- **Daily, on the droplet:** `./backups/shiftbook-YYYY-MM-DD.dump` and `photos-YYYY-MM-DD.tar.gz`, kept for 14 days.
- **Copy them off the droplet too.** Turn on DigitalOcean's weekly droplet backups, or copy `./backups` to a DigitalOcean Spaces bucket each night (for example with `rclone`).
- **Restoring a dump:**
  `docker compose exec -T db pg_restore -U shiftbook_owner -d shiftbook --clean --if-exists < backups/shiftbook-2026-11-06.dump`

## 7. If something goes wrong

| Symptom | Likely cause |
|---|---|
| `app` keeps restarting, log says a migration failed | Read the error in `docker compose logs app`. Nothing is half-applied: each migration runs in a transaction. |
| Sign-in works but every change says "That request didn't come from Shiftbook" | `APP_ORIGIN` doesn't match the address in the browser exactly (`https://`, no trailing slash). |
| Fingerprint set-up fails on every phone | The app must be opened over `https://` at the `APP_ORIGIN` address. Passkeys don't work over plain `http://` or a raw IP address. |
| Everyone's clock-in says "outside the plant boundary" | The power house GPS position hasn't been set, or is wrong. Set it from the manager screen while standing in the control room. |
