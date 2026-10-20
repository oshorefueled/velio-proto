# Velio: group bookings, live availability and invitations

A working prototype for booking a spot in a small group activity, keeping availability live on every open screen, and inviting friends through personal or public invitations. It has three parts: one Fastify API (PostgreSQL + Redis), a responsive React web app, and a Flutter app for invited guests.

The plan behind it is in [PLANS.md](PLANS.md). This README covers how to run it, how it works, how it was verified, and what was observed.

- [Quick start](#quick-start)
- [Architecture](#architecture)
- [Verification and observed results](#verification-and-observed-results)
- [Tracking: goals, reports and triggers](#tracking-goals-reports-and-triggers)
- [Plan versus reality](#plan-versus-reality)
- [Trade-offs and production follow-up](#trade-offs-and-production-follow-up)
- [Demo walkthrough](docs/walkthrough.md)

## Quick start

### Prerequisites

| Tool | Version used | Notes |
| --- | --- | --- |
| Docker Desktop (Compose v2) | 4.x | PostgreSQL 17.6 and Redis 7.4.5 images are pinned. |
| Node.js | 24.16.0 | Pinned in `.nvmrc` and `engines`; `nvm use` picks it up. |
| Flutter SDK | 3.47.7 (Dart 3.13.5) | For the mobile app. |
| Xcode + an iPhone simulator | iOS 17.5 runtime | The default mobile target. Android works with `10.0.2.2` as the API host. |

### 1. Database and Redis

```bash
cp .env.example .env            # local, non-secret development defaults
docker compose up -d --wait     # PostgreSQL on 55432, Redis on 56379
```

To use other ports, set `POSTGRES_PORT` / `REDIS_PORT` for Compose and change the same ports in the `DATABASE_URL`, `MIGRATION_DATABASE_URL` and `REDIS_URL` values in `.env`.

On first boot, `docker/postgres-init.sh` creates two login roles and two databases:

- `velio_migrator` owns the schema and is used only by `npm run migrate`.
- `velio_app` can read and write rows but cannot change the schema. The API runs as this role.
- `velio` is the app database; `velio_test` is used by the backend tests.

Saved history (bookings, attribution, acquisition, measurements) is protected from update and delete for the application role. `backend/test/roles.test.mts` checks this.

To reset to a clean first boot: `docker compose down -v`.

### 2. API

```bash
cd backend
npm ci
npm run migrate                 # applies backend/migrations/*.sql as velio_migrator
EXPERIMENT_TREATMENT_ALLOCATION_PERCENT=100 npm run seed:demo
EXPERIMENT_TREATMENT_ALLOCATION_PERCENT=100 npm start     # http://localhost:3001; keeps running
```

In another terminal, `curl -s localhost:3001/readyz` returns `{"status":"ok",...}` once PostgreSQL and Redis answer.

`seed:demo` creates labelled synthetic data. Every fixture has `dataset='demo'`, which keeps it out of the default real-cohort reports. It creates:

- a demo host (`host@velio.test`) with three activities in London time, priced in GBP, one of which has already started;
- a demo booker (`booker@velio.test`) with saved bookings in two of them. Secret Speakeasy Tour starts fully open, so a booking can be made live during a demo.

Re-running the seed reuses these fixtures. A database seeded before the current fixtures keeps its older ones alongside them, so start a demo from a clean first boot (`docker compose down -v`, then migrate and seed).

The default treatment allocation is 10% (`.env.example`), so most new activities would land in the control group and couldn't issue invitations. The `100` override above puts demo activities in treatment so both invitation types can be shown. Saved assignments never change when the allocation changes.

### 3. Web

```bash
cd web
npm ci
VELIO_API_PROXY=http://127.0.0.1:3001 npm run dev    # http://127.0.0.1:5174
```

The dev server forwards `/api` (including the `/live` WebSocket) to the API, so the API needs no CORS setup.

Use the **Host / Booker / Guest** selector at the top right:

- **Host** and **Booker** switch to the seeded accounts.
- **Guest** signs in with any email, including an account created on mobile.

Invitation links have the form `http://127.0.0.1:5174/?invite=<CODE>`. Set `VITE_INVITE_ORIGIN` to change the origin they use. Production builds read `VITE_API_BASE`.

### 4. Flutter (iPhone simulator)

```bash
cd mobile
flutter pub get
open -a Simulator
flutter run -d "iPhone 15 Pro" --dart-define=VELIO_API_BASE=http://localhost:3001
xcrun simctl openurl booted "velio://invite/<CODE>"   # or type the code into the app
```

- The iOS simulator shares the Mac's localhost. On an Android emulator, use `--dart-define=VELIO_API_BASE=http://10.0.2.2:3001`.
- A fresh install starts signed out.
- The `velio://invite/<CODE>` route and manual code entry use the same preview.

### 5. Checks

From the repository root:

```bash
(cd backend && npm run typecheck && npm test)      # uses velio_test; files run serially on purpose
(cd web && npm run typecheck && npm test && npm run build)
(cd mobile && flutter analyze && flutter test)
```

Real-stack mobile journeys live in `mobile/integration_test/` and run on a simulator against a running API, with `--dart-define` inputs listed in each file:

- `invitation_claim_test.dart`: preview, checkout sign-up, claim, then return through the account alone (a new controller over the same device files, with no remembered invitation).
- `live_availability_test.dart`: another account's booking renders live, plus disconnect recovery.
- `offline_recovery_test.dart`: cached offline reopen, refused offline claim, then sold out after reconnecting.
- `live_viewer_hold_test.dart`: keeps a rendered viewer open for the latency run.

## Architecture

```text
 React web (Vite)          Flutter app
      │  HTTP /api, WS /live    │  HTTP, WS /live
      └────────────┬────────────┘
             Fastify API (one service)
     ┌───────────┬─┴──────────┬────────────┐
 identity    activities    booking      invites / clientevents / metrics / live
     └───────────┴──────┬────┴────────────┘
              PostgreSQL (source of truth)        Redis (Pub/Sub, quotas)
```

There is one service. The modules are identity, activities and plans, booking, invitations and attribution, client events, metrics, and the live gateway. All SQL is parameterized through `pg`, and the schema lives in plain SQL migrations. There are no other services, queues or outbox.

### Accounts

- **Email entry.** Accounts are keyed by normalized email (`POST /demo/sessions`). Account entry finds or creates the account and issues a bearer session.
- **No email verification.** The prototype assumes whoever types an email owns it. This is a deliberate prototype assumption, not production behaviour.
- **Acquisition record.** Each account records, once and immutably, how it was acquired: `direct` at generation 0, or through a vouch or public invitation at the inviter's generation + 1.

### Booking: never oversell

One booking runs in a single `READ COMMITTED` transaction:

1. Lock the activity row (`SELECT … FOR UPDATE`). Finite lock and statement timeouts apply: 2 s and 5 s by default.
2. Return an existing booking for this account and activity before any other check. A replay keeps its original source.
3. Validate a new claim's invitation, recipient email and single redemption. Invitations expire at the activity start.
4. Check the start time on the database clock. Bookings close at start.
5. Check capacity, then increment `booked_count` and the `availability_version`.
6. Insert the booking, its attribution and the confirmed events, then commit.

Any failure rolls all of this back. Unique (account, activity) bookings, single vouch redemption and one public invitation per sharing account and activity are also enforced as database constraints.

The client sends an `operationId` with each booking. If a response is lost, the client looks up the saved booking before it posts again, so an uncertain booking never becomes a second booking.

### Live availability and recovery

After commit, the API publishes `{activityId, version, remainingSpots, eventId}` to Redis Pub/Sub with a 500 ms timeout. Each API instance forwards it to the WebSockets watching that activity. A publication failure never changes the booking outcome.

Clients (web: `web/src/live/availability.ts`; Flutter: `mobile/lib/live_availability.dart`) follow one protocol:

- **Subscribe first.** Register measurement, subscribe, and fetch a database snapshot only after `subscribed`.
- **Newer versions only.** Versions are compared as BigInt; older or duplicate updates are ignored.
- **Refetch to recover.** Fetch a fresh snapshot on `resnapshot`, on reconnect (with backoff), on foreground return, and every 5 s while visible. The periodic refresh stops in the background.
- **Acknowledge after render.** Send `POST /availability-acks` only after the UI has rendered that version, with the source (`websocket` or `snapshot`) and reason.

The owning host's participant list (names, masked emails such as `a***@domain`) refreshes when a newer version arrives. Public live messages carry only counts.

**Measurement.** When a booking starts, the server records which subscribed, visible, measurement-registered viewers are present (PostgreSQL presence with a liveness lease). For each of those viewers, it measures database time before commit to acknowledgement arrival, on the same database clock. This is a conservative upper bound on commit-to-screen time.

A viewer that reconnects presents its previous connection ID. That lets its recovery acknowledgement close the update it missed, with the full delay recorded. A viewer that never returns stays open as missing. Redis Pub/Sub delivers at most once, so missed messages are repaired only by snapshots.

### Invitations and attribution

| | Vouch ("Invite someone") | Public link ("Copy public link") |
| --- | --- | --- |
| Binding | Bound to one recipient email; redeemable once | Reusable; one per sharing account and activity |
| Expiry | When the activity starts | When the activity starts |
| Records | `invite_created` once | `invite_created` once; every copy is a separate `invite_share_action` |

Acquisition (on the account) and booking source (one per booking) are separate, immutable records. A returning account that books through an invitation is not an acquisition.

Each activity is randomly assigned to treatment or control at creation (`activity_experiments`, versioned), and that assignment never changes. Control activities still allow ordinary discovery and booking.

`EXPERIMENT_INVITE_CREATION_ENABLED=false` stops new invitations in both the API (403) and the UI. Invitations already issued still preview and book.

### Observations

Clients send only display and interaction observations to `POST /client-events`: `activity_viewed`, `invite_share_action`, `invite_opened`, `claim_started`. Each carries a unique event ID, a persistent visitor ID, the channel and, where available, a visit ID. An identical retry is a no-op; a changed replay returns `409 event_conflict`.

Booking, invitation, account and claim outcomes are written by the server inside their own transactions.

## Verification and observed results

These are the results from the final state of this branch, observed on 20 October 2026 on an Apple M2 Pro (10 cores, 16 GB, macOS 26.5), with Docker PostgreSQL and Redis, one API instance, everything on localhost.

They are prototype evidence, not production capacity claims.

### Gates

| Check | Result |
| --- | --- |
| Backend `npm run typecheck && npm test` | Pass: 270 tests in 37 files |
| Web typecheck, 110 tests, production build | Pass |
| Flutter `analyze`, 73 tests, iOS simulator build | Pass |
| Clean checkout following this Quick start | Compose, 14 migrations, demo seed, API, web proxy and the gates above all passed. The iOS app claimed against that API, and the mobile-created account then signed in on web and saw its booking. |

### Capacity integrity: zero oversell

Concurrent HTTP and database tests in `backend/test/booking-concurrency.test.mts`, `booking.test.mts` and `booking-claim.test.mts` pass. They cover:

- 50 simultaneous bookers for 1 spot: exactly one booking, the rest sold out;
- 50 simultaneous bookers for 5 spots: exactly five;
- a same-account race collapsing onto one booking;
- a lock timeout consuming nothing;
- a failed attribution insert rolling back every write;
- a failed COMMIT classified as a definitive rollback.

The load run below also reconciles booking rows, stored count, attribution rows and attempts with zero oversell.

### Booking reliability: at least 99.5% eligible success

```bash
cd backend && npm run acceptance:load -- --operations 1000 --in-flight 20 --out load.json
```

**Declared workload.** 1,000 real HTTP bookings, at most 20 in flight, by 1,000 distinct new accounts, on one activity with 1,000 spots, so no sell-outs were expected. It runs on the isolated `velio_test` database with data labelled demo.

**Disclosed overrides:**
- the per-IP booking quota was raised to 1,000,000 (a single-source burst);
- the booking statement timeout was raised to 30 s for the 20-deep queue on one row;
- the lock timeout stayed at 2 s.

| | Observed |
| --- | --- |
| Eligible attempts / successful new bookings | 1000 / 1000 = **100%** (target ≥ 99.5%) |
| Excluded separately | 0 replays, 0 expected sell-outs, 0 invalid, 0 quota rejections |
| Consistency | 1000 booking rows = stored `booked_count` 1000 = 1000 attribution rows; 0 oversold |
| HTTP duration (not rendered latency) | p50 47 ms, p95 1,767 ms, max 7,523 ms (queueing on one locked row) |

If the test database is left partly migrated by an aborted test run, reset it first:

```bash
cd backend && npm run test:reset-db
```

### Rendered availability: p95 at most 2 s across actual viewers

With the API and web app running:

```bash
cd backend && npm run measure:rendered -- --viewers 3 --bookings 30 --spacing-ms 1500 --api http://localhost:3001 --web http://127.0.0.1:5174 --out rendered.json
```

The script prints a web URL and an app code. Open the viewers:

- the activity in two browser windows (the signed-in host and a signed-out visitor);
- the invitation in the Flutter app on the iPhone simulator, or run `integration_test/live_viewer_hold_test.dart` with that code and `--dart-define=VELIO_HOLD_SECONDS=300`, so the viewer outlives the run (the default is 90 s).

The script waits until all declared viewers are registered and visible. It then commits spaced bookings from new accounts and reads `GET /metrics?from=&to=` for exactly that window, on the database clock.

`/metrics` isn't scoped to one activity, so any other booking in the window, or any failed booking, makes the verdict `incomplete`. The run's activity and accounts are labelled demo afterwards.

All viewers on one machine acknowledge from one IP, and the API refuses acknowledgements beyond `AVAILABILITY_ACK_RATE_LIMIT_PER_IP` (240 per hour by default), counted across the whole hour. Refused acknowledgements show up as missing.

For repeated runs, start the API with a raised limit and disclose it, as below. One run tonight without the override recorded 36 refused acknowledgements; the verdict correctly came out as a failure with `missing_acknowledgements` and a lower-bound p95.

The final run used 3 actual viewers (host web, public web, iOS app), 30 bookings 1.5 s apart, and an API started with these disclosed overrides:

```bash
AVAILABILITY_ACK_RATE_LIMIT_PER_IP=100000 BOOKING_RATE_LIMIT_PER_IP=100000
```

| | Observed |
| --- | --- |
| Bookings measured | 30 of 30 committed |
| Capture coverage | 30 captured; 0 unrecorded, 0 capture failures, 0 bookings without viewers |
| Expected-viewer measurements | 90; 90 acknowledged within 2 s (86 within 100 ms); 0 late, 0 missing, 0 disconnected |
| p95 of each booking's slowest viewer | **103 ms** (not a lower bound); verdict `meets` |
| Source / reason | 90 WebSocket (initial lifecycle reason `reconnect`) |

Other runs with the same three viewers tonight:
- **Before quota limits applied:** two runs met the target, with p95 92 ms and 98 ms.
- **Quota refusals:** two runs were not passes and were labelled that way. One had 36 acknowledgements refused by the per-IP acknowledgement quota (verdict `fails`, lower bound). The other had 7 bookings refused by the per-IP booking quota (verdict `incomplete`, `booking_failures`).

**Disconnect recovery evidence** (`integration_test/live_availability_test.dart` with a script that stops the API):

- the app was subscribed when its API was stopped;
- a booking committed through a second API instance with no subscribers;
- the API was restored.

The app rendered the missed version, and its measurement closed as `snapshot` / `interval` after **5,996 ms**. That is recorded as a breach of the 2-second target, not hidden.

`GET /metrics` always reports a p95 as a lower bound when any acknowledgement is missing. It lists late, missing and disconnected viewers and the breakdown by source and reason. HTTP request duration is never used as rendered latency.

## Tracking: goals, reports and triggers

All product reports run through one CLI:

```bash
cd backend
npm run cohorts -- <report> --start <ISO> --end <ISO> [--as-of <ISO>] [--dataset real|demo]
```

- **Reports:** `inviter_adoption`, `invite_conversion`, `k_factor_by_rail`, `holdout_comparison`, `acquisition_audit`.
- **Cohort:** a seven-day half-open window; `--as-of` defaults to the database clock.
- **Dataset:** real by default. Demo fixtures are only included with an explicit `--dataset demo`.

Each run returns:
- the sample counts, numerators and denominators;
- intervals: Wilson 95% for rates, exact Poisson for K-factor;
- maturity, and null rates for zero denominators;
- an `assessment`.

A target is judged (`meets` or `below`) only for a mature, non-empty real cohort. Demo, incomplete and empty runs are marked `not_assessable` with their reasons.

| Goal | Measurement | Target | Trigger |
| --- | --- | --- | --- |
| Never oversell | Oversold activities and stored-count mismatches (`/metrics`, load verification) | 0 | Any oversell or mismatch |
| Bookings succeed | Successful new eligible attempts ÷ eligible attempts; replays, sell-outs, invalid and quota-rejected attempts separated (`/metrics` `bookings.reliability`) | ≥ 99.5% | A declared run or interval below 99.5% |
| Availability feels live | p95 over bookings of the slowest expected viewer, commit to rendered acknowledgement (`/metrics` `availability`) | ≤ 2 s | p95 > 2 s or a missing acknowledgement |
| Bookers become inviters | `inviter_adoption`: first deliberate invitation for the entry activity within 24 h; share actions reported separately | ≥ 30% | A mature treatment cohort below 30% |
| Opened invitations convert | `invite_conversion`: first displayed open per person/visitor and invitation; full/expired/used landings stay in the denominator; by rail, channel and landing state | ≥ 25% | A mature treatment cohort below 25% |
| K-factor by rail | `k_factor_by_rail`: new accounts acquired by a fixed pre-cohort inviter cohort (including non-inviters) ÷ that cohort | None set | K declining across cohorts, or acquisitions not progressing to booking |
| Holdout | `holdout_comparison`: booked participants per assigned activity by version and arm, with CI, difference vs control, mixed-arm exposure | Descriptive | Actual occurrence is **unmeasured** |
| Attribution audit | `acquisition_audit`: immutable signup source and generation beside each booking's source, and K-factor numerator membership | Descriptive | — |

**Identity rules for anonymous activity** (conversion, holdout exposure):

- Use the explicit account if the event carries one.
- Otherwise, use the account entered in the same visit.
- If the event has no visit, use the next account entered on the same device within 24 hours.
- Otherwise, the event stays an unlinked visitor.

A device is never permanently bound to the first account used on it. Identity across devices that never links is a stated limitation.

**Synthetic results.** The demo run below created both invitation types on web and claimed on iOS, then ran the reports with `--dataset demo`. It showed adoption 1/15 (Wilson 1.2%–29.8%) and conversion 1/12. Both were `not_assessable`: demo data, window not mature. Synthetic fixtures establish arithmetic and event plumbing only; they say nothing about real adoption, conversion or causal lift.

## Plan versus reality

The agreed product changes are recorded in [PLANS.md](PLANS.md) section 3.6. The implementation-level changes are recorded here and in the commit history.

- **Accounts and itinerary.** Email account entry and recipient-bound vouches replaced demo contact keys. The shared plan is an explicit itinerary.
- **Host completion removed.** Host-reported completion, its report and its acceptance checks are gone. The holdout compares booked participants per activity as an intermediate outcome, and occurrence stays unmeasured. The `plans.completed*` columns remain only so committed history isn't rewritten.
- **Invitation lifetime.** Invitations expire when the activity starts. The old lifetime and creation-quota settings are still accepted but do not gate anything.
- **Mobile is the primary claim path.** Flutter claiming came first; desktop invitation claiming stays secondary.
- **Localhost delivery.** Previews are delivered over localhost HTTP; HTTPS and verified link association are deployment follow-up.
- **Measurement across reconnects.** A reconnecting viewer can now close the update it missed, with the full delay recorded (migration 0014). Before this, a disconnect left the update open forever even after the viewer rendered it.
- **Flutter snapshot source.** Flutter live snapshots read `GET /activities/:id`. Polling the per-IP-limited invitation resolve every 5 s would lock users out in about 10 minutes.
- **Anonymous attribution.** Anonymous activity links to its own visit's account entry instead of the device's first-ever account.
- **Open decision: booking quota.** The booking quota (30 per account and 120 per IP per hour) is still active as a safety limit. It's outside the acceptance checks: reliability excludes quota rejections, and the load run discloses its override. The spec lists booking quotas among behaviour to remove, so this is a decision for the owner.

## Trade-offs and production follow-up

Within the 48 hours, these were prioritized:

- capacity correctness;
- honest measurement;
- the guest's mobile journey;
- report correctness, over breadth.

| Area | Prototype choice | Production follow-up |
| --- | --- | --- |
| Live delivery | Redis Pub/Sub, at most once, with snapshot repair | A transactional outbox if measured publication failures justify it; operational alerting |
| Identity | Unverified email entry; bearer sessions | Real authentication and email verification; abuse controls |
| Scale | One API instance, one machine, one hot row tested | Multi-instance load and latency runs on production-like hardware; connection-pool and lock budgets per environment |
| Reports | Correlated SQL suitable for prototype volumes | Bound identity resolution to the cohort window; materialize cohorts; run on real cohorts before judging the 30% and 25% targets |
| Experiment | Activity-level holdout, versioned allocation, kill switch | Agree occurrence evidence, power the comparison from baseline data, then run a 50/50 test |
| Mobile | Custom-scheme links; simulator verification | Verified HTTPS links, store and deferred install, physical-device haptics |
| Booking lifecycle | One spot per account; no cancellation | Cancellation, waitlist, host edits with rules for existing bookers |

The one-page ownership response is a separate document.
