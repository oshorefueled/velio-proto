# Velio: group bookings, live availability and invitations

A working prototype for booking a spot in a small group activity, keeping availability live on every open screen, and inviting friends through personal or public invitations. It has three parts: one Fastify API (PostgreSQL + Redis), a responsive React web app, and a Flutter app for invited guests.

The plan behind it is in [PLANS.md](PLANS.md). A scripted demo is in [docs/walkthrough.md](docs/walkthrough.md).

- [Quick start](#quick-start)
- [Architecture and decisions](#architecture-and-decisions)
- [Plan vs. reality](#plan-vs-reality)
- [Trade-offs](#trade-offs)
- [Where to see the tracking](#where-to-see-the-tracking)

## Quick start

| Tool | Version used |
| --- | --- |
| Docker Desktop (Compose v2) | 4.x (PostgreSQL 17.6 and Redis 7.4.5 images are pinned) |
| Node.js | 24.16.0 (`.nvmrc`) |
| Flutter SDK | 3.47.7 (Dart 3.13.5) |
| Xcode + iPhone simulator | iOS 17.5 runtime or later |

**1. Database and Redis**

```bash
cp .env.example .env            # local, non-secret development defaults
docker compose up -d --wait     # PostgreSQL on 55432, Redis on 56379
```

On first boot, `docker/postgres-init.sh` creates the `velio` and `velio_test` databases and two roles: `velio_migrator` owns the schema, and `velio_app`, which the API runs as, can read and write rows but not change the schema. Saved history (bookings, attribution, acquisition) can't be updated or deleted by `velio_app`. To start again from a clean first boot: `docker compose down -v`.

**2. API**

```bash
cd backend
npm ci
npm run migrate
EXPERIMENT_TREATMENT_ALLOCATION_PERCENT=100 npm run seed:demo
EXPERIMENT_TREATMENT_ALLOCATION_PERCENT=100 npm start     # http://localhost:3001
```

`seed:demo` creates a host (`host@velio.test`) with three activities in London time and GBP, one already started, and a booker (`booker@velio.test`) booked into two of them. Secret Speakeasy Tour starts fully open for a live booking. All seeded rows are labelled `dataset='demo'`, so real-cohort reports ignore them. The `100` override puts demo activities in the invitation treatment arm; the default allocation is 10%.

**3. Web**

```bash
cd web
npm ci
VELIO_API_PROXY=http://127.0.0.1:3001 npm run dev    # http://127.0.0.1:5174
```

Use the **Host / Booker / Guest** selector at the top right. Host and Booker switch to the seeded accounts; Guest signs in with any email, including one created on mobile.

**4. Flutter (iPhone simulator)**

```bash
cd mobile
flutter pub get
open -a Simulator
flutter run -d "iPhone 15 Pro" --dart-define=VELIO_API_BASE=http://localhost:3001
xcrun simctl openurl booted "velio://invite/<CODE>"   # or type the code into the app
```

On an Android emulator, use `VELIO_API_BASE=http://10.0.2.2:3001`.

**Running the checks**

```bash
(cd backend && npm run typecheck && npm test)      # uses velio_test; files run serially
(cd web && npm run typecheck && npm test && npm run build)
(cd mobile && flutter analyze && flutter test)
```

Real-stack mobile journeys (claim, live updates, offline recovery) are in `mobile/integration_test/` and run on a simulator against a running API.

## Architecture and decisions

```text
 React web (Vite)          Flutter app
      │  HTTP /api, WS /live    │  HTTP, WS /live
      └────────────┬────────────┘
             Fastify API (one service)
     ┌───────────┬─┴──────────┬────────────┐
 identity    activities    booking      invites / clientevents / metrics / live
     └───────────┴──────┬────┴────────────┘
              PostgreSQL (source of truth)        Redis (Pub/Sub)
```

One service with modules for identity, activities and plans, booking, invitations and attribution, client events, metrics and the live gateway. PostgreSQL owns capacity and history; all SQL is parameterized through `pg` and the schema lives in plain SQL migrations. Redis carries live availability between API instances and their WebSockets.

**Concurrency: never oversell.** Each booking is one `READ COMMITTED` transaction:

1. Lock the activity row (`SELECT … FOR UPDATE`), with finite lock and statement timeouts.
2. Return the account's existing booking for this activity if there is one, keeping its original source.
3. For an invited claim, check the invitation, the vouch recipient's email and single redemption.
4. Check the start time on the database clock, then capacity.
5. Increment `booked_count` and `availability_version`, insert the booking, its attribution and its events, and commit.

Any failure rolls everything back. Unique bookings per account and activity, single vouch redemption and one public invitation per sharing account and activity are also database constraints. Clients send a stable `operationId`; after a lost response they look up the saved booking before posting again, so an uncertain booking never becomes a second one. Row locking keeps capacity, duplicate and invitation checks in one transaction boundary; an atomic conditional update would still need those checks around it, and Redis locks would coordinate outside the database that commits the booking.

**Real-time availability.** After commit, the API publishes `{activityId, version, remainingSpots}` to Redis Pub/Sub; each instance forwards it to the WebSockets watching that activity. Publication can never change a booking's outcome. Web and Flutter follow the same client protocol: subscribe, then fetch a snapshot; apply only newer versions; refetch on reconnect, on returning to the foreground and every 5 s while visible; and acknowledge each version only after it has rendered. Pub/Sub delivers at most once, so snapshots repair anything missed.

**Invitations and attribution.**

| | Vouch ("Invite") | Public link ("Or generate a public invite") |
| --- | --- | --- |
| Binding | One recipient email; redeemable once | Reusable; one per sharing account and activity |
| Expiry | When the activity starts | When the activity starts |
| Records | `invite_created` once | `invite_created` once; each copy is an `invite_share_action` |

An account records once how it was acquired (`direct` at generation 0, or a vouch or public invitation at the inviter's generation + 1), and each booking records its own source. Both are immutable: database grants and triggers reject updates and deletes. Each activity is assigned to treatment or control when it's created, and that assignment never changes. Control activities keep ordinary booking. `EXPERIMENT_INVITE_CREATION_ENABLED=false` stops new invitations while issued ones still work.

**Events.** Clients send only display and interaction observations (`activity_viewed`, `invite_share_action`, `invite_opened`, `claim_started`) with unique event and visitor IDs; retries are idempotent. Booking, invitation, account and claim outcomes are written by the server inside their own transactions.

## Plan vs. reality

The agreed product changes are recorded in [PLANS.md](PLANS.md) section 3.6. Implementation-level differences:

- **Accounts and itinerary.** Email account entry and recipient-bound vouches replaced demo contact keys. The shared plan is an explicit itinerary.
- **Host completion removed.** Host-reported completion and its report are gone. The holdout compares booked participants per activity as an intermediate outcome; whether plans actually happen stays unmeasured. The `plans.completed*` columns remain so committed history isn't rewritten.
- **Invitation lifetime.** Invitations expire when the activity starts.
- **Mobile is the primary claim path.** Flutter claiming came first; desktop claiming stays secondary.
- **Localhost delivery.** Previews are delivered over localhost HTTP; HTTPS and verified link association are deployment follow-up.
- **Measurement across reconnects.** A viewer that reconnects can close the update it missed, with the full delay recorded.
- **Anonymous attribution.** Anonymous activity links to the account entered in its own visit, not the device's first-ever account.

## Trade-offs

Within the 48 hours, capacity correctness, honest measurement, the guest's mobile journey and report correctness came before breadth.

| Area | Prototype choice | Production follow-up |
| --- | --- | --- |
| Live delivery | Redis Pub/Sub, at most once, with snapshot repair | A transactional outbox if measured publication failures justify it; alerting |
| Identity | Unverified email entry; bearer sessions | Real authentication and email verification; abuse controls |
| Scale | One API instance on one machine; one hot row tested | Multi-instance load and latency runs on production-like hardware |
| Reports | Correlated SQL sized for prototype volumes | Materialized cohorts; run on real cohorts before judging the 30% and 25% targets |
| Experiment | Activity-level holdout, versioned allocation, kill switch | Agree occurrence evidence, power the comparison from baseline data, then run 50/50 |
| Mobile | Custom-scheme links; simulator verification | Verified HTTPS links, store and deferred install, physical-device haptics |
| Booking lifecycle | One spot per account; no cancellation | Cancellation, waitlist, host edits with rules for existing bookers |

## Where to see the tracking

**Technical metrics.** `GET /metrics` (e.g. `curl -s localhost:3001/metrics`, optionally `?from=&to=`) reports booking attempts and outcomes, the eligible-success ratio, oversold activities and stored-count mismatches, Redis publication counts, and rendered-availability latency. Latency is the p95 over bookings of the slowest expected viewer, from commit to that viewer's post-render acknowledgement, on the database clock. When any acknowledgement is missing, the p95 is reported as a lower bound and the missing viewers are listed.

**Product reports.** One CLI answers each product goal:

```bash
cd backend
npm run cohorts -- <report> --start <ISO> --end <ISO> [--as-of <ISO>] [--dataset real|demo]
```

| Goal | Report | Target | Improvement trigger |
| --- | --- | --- | --- |
| Bookers become inviters | `inviter_adoption`: first deliberate invitation for the entry activity within 24 h | ≥ 30% | A mature treatment cohort below 30% |
| Opened invitations convert | `invite_conversion`: first displayed open per person and invitation; full, expired and used landings stay in the denominator | ≥ 25% | A mature treatment cohort below 25% |
| K-factor by rail | `k_factor_by_rail`: accounts acquired by a fixed inviter cohort, vouch vs. public | None set | K declining across cohorts |
| Causal lift | `holdout_comparison`: booked participants per activity by arm, with CI and difference vs. control | Descriptive | — |
| Attribution audit | `acquisition_audit`: signup source and generation beside each booking's source | Descriptive | — |

Each report returns its counts, numerators and denominators, 95% intervals and cohort maturity. A target is judged only for a mature, non-empty real cohort; demo and immature runs are marked `not_assessable`. Seeded data proves the plumbing, not real adoption or conversion.

**SLOs against the prototype.** Observed on 20 October 2026 on an Apple M2 Pro with Docker PostgreSQL and Redis, one API instance, everything on localhost. These are prototype evidence, not production capacity claims.

| Goal | Target | Observed | How to reproduce |
| --- | --- | --- | --- |
| Never oversell | 0 oversold | 0. 50 simultaneous bookers for 1 spot produce exactly one booking; the load run below reconciles 1,000 booking rows = stored count = attribution rows | `npm test` (`booking-concurrency.test.mts`), and the load run |
| Bookings succeed | ≥ 99.5% | 1,000 / 1,000 = 100%: 1,000 new accounts, at most 20 in flight, one activity with 1,000 spots. The booking statement timeout was raised to 30 s for the queue on one row | `npm run acceptance:load -- --operations 1000 --in-flight 20` |
| Availability feels live | p95 ≤ 2 s | p95 446 ms; 90 of 90 viewer updates within 2 s (82 within 100 ms), all over WebSocket. 3 viewers (2 browsers and the iOS app), 30 bookings 1.5 s apart | With the API and web app running, `npm run measure:rendered -- --viewers 3 --bookings 30 --spacing-ms 1500`, then open the viewers it prints |

The one-page ownership response is a separate document.
