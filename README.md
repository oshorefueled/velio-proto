# Velio: group bookings, live availability and invitations

A prototype for booking a spot in a small group activity, keeping availability live on every open screen, and inviting friends through personal or public invitations. It has three parts:

1. Fastify API (PostgreSQL + Redis)
2. React web app
3. Flutter app for invited guests.

The plan behind it is in [PLANS.md](PLANS.md). 

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

`seed:demo` creates a host (`host@velio.test`) with three activities in London time and GBP, one already started, and a booker (`booker@velio.test`) booked into two of them. Secret Speakeasy Tour starts fully open for a live booking. All seeded rows are labelled `dataset='demo'`, so the product reports leave them out unless asked to include them. Invitations run as an experiment: by default only 10% of new activities can issue invitations and the rest form the holdout. The `100` override lets every demo activity issue invitations.

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
2. If this account already booked the activity, return that booking. A retry never creates a second booking and keeps the invitation that originally brought the person in.
3. For an invited claim, check the invitation, the vouch recipient's email and single redemption.
4. Check the start time on the database clock, then capacity.
5. Increment `booked_count` and `availability_version`, insert the booking, its attribution and its events, and commit.

Any failure rolls everything back. Unique bookings per account and activity, single vouch redemption and one public invitation per sharing account and activity are also database constraints. Clients send a stable `operationId`; after a lost response they look up the saved booking before posting again, so an uncertain booking never becomes a second one. Row locking keeps capacity, duplicate and invitation checks in one transaction boundary; an atomic conditional update would still need those checks around it, and Redis locks would coordinate outside the database that commits the booking.

**Real-time availability.** After commit, the API publishes `{activityId, version, remainingSpots}` to Redis Pub/Sub; each instance forwards it to the WebSockets watching that activity. Publication can never change a booking's outcome. Web and Flutter follow the same client protocol: subscribe, then fetch a snapshot; apply only newer versions; refetch on reconnect, on returning to the foreground and every 5 s while visible; and acknowledge each version only after it has rendered, which is how on-screen latency is measured. Pub/Sub delivers at most once, so snapshots repair anything missed.

**Invitations and attribution.**

| | Vouch ("Invite") | Public link ("Or generate a public invite") |
| --- | --- | --- |
| Binding | One recipient email; redeemable once | Reusable; one per sharing account and activity |
| Expiry | When the activity starts | When the activity starts |
| Records | `invite_created` once | `invite_created` once; each copy is an `invite_share_action` |

An account records once how it was acquired (`direct` at generation 0, or a vouch or public invitation at the inviter's generation + 1), and each booking records its own source. Both are immutable: database grants and triggers reject updates and deletes. Each activity is assigned to treatment or control when it's created, and that assignment never changes. Control activities keep ordinary booking. `EXPERIMENT_INVITE_CREATION_ENABLED=false` stops new invitations while issued ones still work.

**Events.** Clients send only display and interaction observations (`activity_viewed`, `invite_share_action`, `invite_opened`, `claim_started`) with unique event and visitor IDs; retries are idempotent. Booking, invitation, account and claim outcomes are written by the server inside their own transactions.

## Plan vs. reality

The build follows [PLANS.md](PLANS.md). The plan changed in a few places while building, and section 3.6 records each change:

- **Email accounts instead of a contact picker.** A vouch has to reach the person it was meant for, and a forwarded link alone can't establish that. So accounts are keyed by email, and each vouch is bound to its recipient's email and checked at checkout.
- **Hosts choose a country, not a timezone.** The activity's timezone follows from the country, so the two can't contradict each other.
- **Public invites are generated, then copied.** Generating creates the sharer's reusable link; each copy is recorded separately from creation.
- **Mobile first for claiming.** Invited guests claim in the Flutter app. Claiming on desktop web is follow-up.

**Not built: attendance and plans that actually happen.** The brief asks for hosts to see live attendance, and names plans that actually happen as a core metric. There's no agreed way yet to confirm that someone turned up or that an activity took place, so the host sees live bookings instead. The holdout compares booked participants per activity, and bookings are never counted as attendance. A host-reported "completed" flag was planned and dropped until there's an agreed definition of a plan happening.

## Trade-offs

Within the 48 hours, these came before breadth: never overselling, measurements that report misses instead of hiding them, the invited guest's mobile journey, and reports that compute the goals correctly.

| Area | Prototype choice | Production follow-up |
| --- | --- | --- |
| Live delivery | Redis Pub/Sub, at most once, with snapshot repair | A transactional outbox if measured publication failures justify it; alerting |
| Identity | Unverified email entry; bearer sessions | Real authentication and email verification; abuse controls |
| Scale | One API instance on one machine; contention tested on a single activity | Multi-instance load and latency runs on production-like hardware |
| Reports | Correlated SQL sized for prototype volumes | Materialized cohorts; run on real cohorts before judging the 30% and 25% targets |
| Experiment | Activity-level holdout, versioned allocation, kill switch | Agree how to confirm a plan happened, size the test from baseline data, then run 50/50 |
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
| Bookers become inviters | `inviter_adoption`: share of new bookers who create an invitation for the activity they booked within 24 hours. Viewing the invite card doesn't count | ≥ 30% | A mature treatment cohort below 30% |
| Opened invitations convert | `invite_conversion`: share of opened invitations, counted once per person, that end in a claimed spot. Opens of full, expired or used invitations still count | ≥ 25% | A mature treatment cohort below 25% |
| K-factor by rail | `k_factor_by_rail`: new accounts brought in per existing user, split by vouch and public link | None set | K declining across cohorts |
| Causal lift | `holdout_comparison`: booked participants per activity, invitation activities vs. the holdout, with confidence intervals | Descriptive | — |
| Attribution audit | `acquisition_audit`: signup source and generation beside each booking's source | Descriptive | — |

Each report returns its counts, numerators and denominators, and 95% intervals. Cohorts cover a seven-day window, and a cohort is mature once its observation period has ended. A target is judged only for a mature, non-empty cohort of real users; demo and immature runs are marked `not_assessable`. Seeded data proves the plumbing, not real adoption or conversion.

**SLOs against the prototype.** Observed on 20 October 2026 on an Apple M2 Pro with Docker PostgreSQL and Redis, one API instance, everything on localhost. These are prototype evidence, not production capacity claims.

| Goal | Target | Observed | How to reproduce |
| --- | --- | --- | --- |
| Never oversell | 0 oversold | 0. 50 simultaneous bookers for 1 spot produce exactly one booking; the load run below reconciles 1,000 booking rows = stored count = attribution rows | `npm test` (`booking-concurrency.test.mts`), and the load run |
| Bookings succeed | ≥ 99.5% | 1,000 / 1,000 = 100%: 1,000 new accounts, at most 20 in flight, one activity with 1,000 spots. The booking statement timeout was raised to 30 s for the queue on one row | `npm run acceptance:load -- --operations 1000 --in-flight 20` |
| Availability feels live | p95 ≤ 2 s | p95 446 ms; 90 of 90 viewer updates within 2 s (82 within 100 ms), all over WebSocket. 3 viewers (2 browsers and the iOS app), 30 bookings 1.5 s apart | With the API and web app running, `npm run measure:rendered -- --viewers 3 --bookings 30 --spacing-ms 1500`, then open the viewers it prints |

The one-page ownership response is a separate document.
