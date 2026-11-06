# Shiftbook

Attendance, leave, overtime and monthly duty roster for Nyamwamba 1 HPP and Nyamwamba 2 HPP.
Self-hosted: Postgres and a Node.js API in Docker, on DigitalOcean, behind Cloudflare.

**Status:** built and tested end to end: database, permissions, sign-in, roster and overtime rules, clock-in checks, API, the phone app (installable web app), and Docker setup. What's left is your real details (see "Still to confirm") and deploying.

## What's in this folder

| Path | What it is |
|---|---|
| `docs/ARCHITECTURE.md` | How it fits together, how buddy-punching is stopped, and the trade-offs |
| `docs/DEPLOY.md` | Step-by-step: DigitalOcean droplet, Docker Compose, Cloudflare, backups |
| `docker-compose.yml`, `Dockerfile`, `.env.example` | The containers: database, app, daily backups, optional Cloudflare Tunnel |
| `db/migrations/` | The database: tables, permission rules, guards, kiosk PINs, sign-in |
| `db/seed.sql` | Starting data: both plants' staff, shift hours, public holidays, Nyamwamba 1's November roster |
| `api/src/` | The API: sign-in, passkeys, clock-in, kiosk, manager tools, rosters, leave, overtime |
| `web/` | The phone app: screens in `web/src/views/`, styles in `web/static/`. `npm run build` puts it in `api/public/` |
| `shared/rules.ts` | Roster, cover and overtime rules, shared by the app and server |
| `db/tests/`, `*.test.ts`, `web/e2e/` | Automated tests |
| `prototype/index.html` | The prototype. Double-click to open. |

## How clock-in works

- **Personal phone:** tap Clock in, scan the QR code on the control-room phone, then touch the fingerprint sensor. The server checks the fingerprint passkey, that the QR code is current (it changes every 30 seconds), and the GPS position.
- **Control-room phone:** shows the QR code. Staff without a smartphone tap their name, enter their PIN and take a photo.
- **A new phone can't clock in until the Plant Manager approves it.** This stops a colleague who learns your sign-in from setting up their own fingerprint as you.
- **Handover:** the outgoing shift head confirms who arrived. Anything that doesn't match goes to the Plant Manager.

## Rules built in

- Shift team: 2 days (07:00–19:00), 2 nights (19:00–07:00), 2 off, in crews A, B and C. Relief (R) covers.
- Every night has exactly 2 people: a shift head (Plant Technician or Plant Technician II) and a Plant Assistant. The database refuses to submit or approve a roster that breaks this.
- Cover is suggested cheapest first. The Plant Technician II staying to 19:00 costs 2 hours. A call-in on a day off costs 12.
- Overtime is settled monthly against 48 hours a week, pro rata. Overtime pays 1.5×. Public-holiday hours pay 2×, including the hours after midnight on the night before a holiday.

## The screens

| Who | Screens |
|---|---|
| Everyone | **Today** (clock in or out, next 7 days, this month's hours), **Monthly roster**, **Leave**, **Overtime**, **Timesheet**, **Settings** (set up fingerprint, control-room PIN, password) |
| Plant Technician II | Also **Team today** (who's on, who's clocked in, off sick and cover) and builds their plant's roster: start from the rotation, paint codes, fix the checks, book cover cheapest first, submit |
| Plant Manager | Also **Approvals** (rosters, new phones, leave, overtime), **Exceptions** (flagged and missed clock-ins with photos, handover mismatches), **Staff** (sign-ins, password resets, moves between plants), and plant boundaries, control-room phones, holidays and the rotation in Settings |
| Control-room phone | Opens at `/#kiosk`: the rotating code, plus PIN and photo clock-in for staff without a phone |

## Run the tests

Needs Node 22.6 or later, and a Postgres 16 server where user `postgres` can connect.

```
cd api && npm install
npm test                                              # rules, clock-in checks (24 tests)
TEST_PG_HOST=/var/run/postgresql npm test             # plus the end-to-end API tests (13)
PGHOST=/var/run/postgresql PGUSER=postgres ../db/tests/run.sh   # database permissions and sign-in (94)
node ../web/e2e/flow.cjs     # the whole app in a browser (27 checks); see the note at the top of the file
```

To work on the app: `cd web && npm install && npm run watch`, then run the API with `npm start` in `api/`.

## Deploy

See `docs/DEPLOY.md`. In short: create a Cloudflare Tunnel pointing at `app:8080`, copy the folder to the droplet, run `sudo bash scripts/install.sh`, then `sudo bash scripts/create-manager.sh` for your own sign-in.

## Still to confirm
- Brenda Biira's shift letter (B is assumed).
- Whether Amos Kikenge is shared or Nyamwamba 1 only.
- Shift F hours: 08:00–17:00 (used) or 07:00–19:00 as the schedules show.
- The real names for the shared positions (Plant Manager, Maintenance Supervisor, Site Admin, EHS Officer).
- Employee numbers for Nyamwamba 1 staff and Adolf Ategeka.
- The GPS position of each power house (or the Plant Manager sets it in Settings, standing in the power house).
- The public-holiday rate: 2× is assumed.
