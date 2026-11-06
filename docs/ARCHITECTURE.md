# Shiftbook architecture

Attendance, leave, overtime and monthly duty roster for Nyamwamba 1 HPP and Nyamwamba 2 HPP.

## 1. Requirements

### What it does
- Staff clock in and out, see their roster, request leave and claim overtime.
- Each plant's Plant Technician II builds the monthly duty schedule and submits it to the Plant Manager.
- The Plant Manager approves rosters, leave and overtime, and sees attendance across both plants.
- Every shift has exactly 2 people: a Plant Technician (or Plant Technician II) as shift head, and a Plant Assistant. Night shifts are strict.
- Cover for sick or absent staff is suggested cheapest first.
- Overtime is settled monthly against 48 hours a week. Overtime pays 1.5×, and public-holiday hours pay 2×.
- **Nobody can clock in for a colleague who isn't there.**

### Scale and constraints
- About 30 people across two plants and shared staff. Clock-ins come in bursts at 07:00, 08:00 and 19:00. Load is tiny.
- Staff use personal Android phones on mobile data. Each control room has one shared phone.
- Connectivity can drop, so clock-in must not fail just because a signal was weak for a minute.
- Low running cost. One administrator, who builds the app with Claude.

## 2. High-level design

```
 Personal phone (PWA)          Control-room phone (PWA, kiosk mode)
 - roster, leave, overtime     - shows rotating QR code (changes every 30 s)
 - fingerprint passkey         - "Clock in here" for staff without a phone:
 - scans kiosk QR                tap your name + PIN + live photo
 - sends GPS position
        |  HTTPS, session cookie           |  HTTPS, kiosk token
        v                                  v
   Cloudflare (DNS, TLS, proxy or tunnel)
        |
 DigitalOcean droplet, Docker Compose
 +-----------------------------------------------------------+
 | app      Node.js (Fastify) API + the PWA's files          |
 |          sign-in, passkeys, clock-in checks, data routes   |
 |          photos on the "photos" volume                     |
 | db       Postgres 16: tables, row-level security, guards  |
 | backup   daily database dump + photo archive              |
 | tunnel   optional Cloudflare Tunnel (no open ports)       |
 +-----------------------------------------------------------+
```

- **Frontend:** one progressive web app (PWA), served by the same container and installable on Android from the browser. Same screens as the prototype, with the role coming from the signed-in account.
- **API:** Node.js with Fastify. Each request runs in a database transaction as the signed-in person (`SET LOCAL ROLE authenticated` plus their ID), so **Postgres row-level security decides what each person sees and changes**, not the API code. Server-only work (clock-in checks, kiosk, sign-in) runs as `service_role`.
- **Sign-in:** username and password, with bcrypt hashes in Postgres. Sessions are httpOnly, Secure, SameSite cookies, and only a hash of the token is stored. Five wrong passwords lock the account for 15 minutes, and login is rate-limited per address. A temporary password must be changed at first sign-in.
- **Rules:** one shared TypeScript module (`shared/rules.ts`) holds the roster, cover and overtime rules, so screens and server calculate the same numbers.

## 3. Stopping buddy-punching

A username and PIN prove only that someone knows the PIN. Each clock-in has to prove two separate things.

| Proof | Personal phone | Control-room phone |
|---|---|---|
| **Who** is clocking in | Passkey unlocked by the phone's fingerprint or face. It can't be copied off the phone. | Employee number + PIN, plus a live photo the Plant Manager can review. |
| **Where** they are | Scans the rotating QR code on the control-room phone, plus GPS inside the plant's boundary. | The phone is registered to the plant and stays in the control room. |

Supporting controls:
- **Rotating QR code.** The kiosk computes it from a secret that only the kiosk and the server hold (HMAC-SHA256 over 30-second windows). The server accepts the current and previous window, so a photo of the code sent to a friend stops working within a minute. It works even if the kiosk is briefly offline.
- **Shift-head handover.** At 07:00 and 19:00 the outgoing shift head confirms who actually arrived. A clock-in with no matching handover is flagged.
- **One phone, one person.** Each browser gets a random device ID. If one phone clocks in two different people within 12 hours, both clock-ins are flagged.
- **Flags, not silent rejection, for borderline cases.** Examples: GPS outside the boundary but the QR code valid, no GPS fix, a kiosk clock-in, late. Flags go to the Plant Manager's exceptions list. Hard rejects are kept for things that can't be legitimate: a wrong or expired QR code, a failed passkey check, or a wrong PIN.
- **Audit log.** Every approval, roster edit, cover booking and manual correction records who did it and when.

What this doesn't stop: two colleagues who both stand in the control room, with one using the other's phone and finger. The handover check and the shared-device flag make that visible, but a wall-mounted fingerprint reader would be the next step up.

## 4. Data model

| Table | Purpose |
|---|---|
| `plants` | Nyamwamba 1 and 2: name, schedule title, boundary centre and radius |
| `staff` | One row per person: employee no., name, designation, app role, shift letter. Linked to a sign-in in `auth.users`. |
| `staff_assignments` | Which plant someone works at, from which date. Handles transfers such as Raphael moving on 7 Nov 2026. |
| `shift_definitions` | The Working Hour/Day table: A, B, C, R, F, E, G |
| `holidays` | Public holidays. Managers can add or remove them. |
| `settings` | Rotation start date, rates, weekly contract hours |
| `rosters` | One per plant per month: status (draft, submitted, returned, approved), who prepared and approved it |
| `roster_cells` | One duty code per person per day, with its source (rotation, manual, cover, leave, import) |
| `cover_assignments` | Who covers whom, on which shift, and the overtime it adds |
| `leave_requests`, `overtime_claims` | Requests and decisions |
| `clock_events` | Every clock-in and out: method, kiosk, passkey, GPS, photo, flags |
| `handovers` | The outgoing shift head's confirmation of who arrived |
| `devices`, `device_secrets` | Registered control-room phones and their QR secrets (server-only) |
| `passkeys`, `webauthn_challenges` | Fingerprint passkeys and one-time challenges (server-only) |
| `staff_secrets` | Hashed kiosk PINs (server-only) |
| `audit_log` | Who did what |
| `auth.users`, `auth.sessions` | Sign-ins (bcrypt hashes) and sessions (token hashes). Not readable from the app. |

## 5. Permissions (row-level security)

| | Staff | Plant Technician II | Plant Manager |
|---|---|---|---|
| Own clock-ins, leave, overtime | read; create requests | read | read all |
| Plant's clock-ins, leave, overtime | – | read, own plant only | read and decide, both plants |
| Roster | read once approved | create and edit while draft or returned, then submit | read all, approve, return, reopen |
| Cover bookings | – | own plant, while the roster is a draft | both plants, any time |
| Clock-in rows | never written directly; only the clock-in routes (as `service_role`) write them | | |
| Secrets, passkeys, PIN hashes | never readable from the app | | |

Status changes are checked in the database (a trigger on `rosters`, `leave_requests` and `overtime_claims`), so a modified app still can't approve its own roster or overtime.

## 6. Trade-offs

| Decision | Why | Cost |
|---|---|---|
| Self-hosted on a DigitalOcean droplet with Docker | You already run apps there, and you keep full control of the data | You maintain the droplet: updates, backups, disk space |
| Postgres row-level security, with the API as a thin layer | Permissions live in one place and are tested directly (94 database tests). A bug in a route can't leak another plant's data. | Every request opens a short transaction, which is negligible at this size |
| Cloudflare Tunnel (or proxied DNS) in front | TLS, DDoS protection and no open web ports on the droplet | Depends on Cloudflare being up |
| PWA, not an app-store app | One codebase, installs from a link, works on cheap Android phones | Some phones handle passkeys less smoothly than native apps |
| HMAC QR codes generated on the kiosk | Keeps working when the kiosk's signal drops | The kiosk secret must be protected. A lost kiosk is removed from the manager screen. |
| Flags rather than hard blocks on GPS | GPS drifts in valleys and inside power houses | The Plant Manager has to review exceptions |
| Photos on a Docker volume | Simple, with a daily archive | Move them to DigitalOcean Spaces if the volume grows large |

## 7. Revisit as it grows
- Offline clock-in queue: store a signed clock-in on the phone and send it when signal returns.
- A fingerprint reader at each control room, if the photo review turns up abuse.
- A payroll export in the exact format HR uses.
- SMS or WhatsApp alerts to the Plant Manager for uncovered night shifts.
