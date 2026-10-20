# Group bookings, live availability and invitations

Revised 19 October 2026.

Hosts publish activities with limited spots. People book into a shared itinerary, then invite others through either a personal vouch or a public link. Invited guests can inspect the activity and claim a spot in the mobile app, while everyone viewing the activity sees availability change as bookings are confirmed.

## 1. Scope questions and working assumptions

| Question or concern | Category | Working decision |
| --- | --- | --- |
| How do we establish that a vouch is claimed by the person the inviter intended to endorse? A forwarded link alone does not establish that relationship. | Unclear requirement | Bind each vouch to a recipient email and match it at checkout. Email ownership is assumed verified for the prototype. The inviter shares a link or code; email delivery is a separate capability. |
| What does Plan represent, and can an activity contain more than one? | Unclear requirement | Treat Plan as the activity's itinerary or agenda. Each activity has one shared plan, which every successful booker joins. A host can create several independent activities. |
| Can people book after an activity starts, and when should invitations expire? | Edge case: late booking | Close booking at activity start and use that deadline for invitation expiry. Selling out is a separate capacity state. A configurable earlier deadline is follow-up work. |
| What evidence establishes attendance and that a plan actually happened? The scope names both outcomes without defining how they are recorded. | Unmeasurable outcome as written | Defer actual live attendance and completion measurement until their operational rules are agreed. Disclose this implementation gap. Bookings remain measurable, but do not establish physical presence or actual occurrence. |
| How does a first-time guest move from an invitation to the appropriate client without losing context, including arrival on desktop or without the app? | User problem: invitation continuity | Prioritize the Flutter claiming journey, preserve the invitation through account entry and checkout, and retain code entry as a fallback. Provide a responsive invitation preview. Desktop claiming and installation handoff follow the essential mobile journey. |

The numerical targets remain unchanged. The measurement concern above applies to actual attendance and plans that happen.

## 2. Technical implementation plan

### 2.1 Architecture and data model

Use one Node.js/TypeScript service with Fastify, parameterized SQL through `pg`, and SQL migrations. React/TypeScript with Vite serves the responsive web app; Flutter serves the invited-guest mobile journey. Docker Compose runs PostgreSQL and Redis.

The service contains activity/plan, booking, invitation/attribution and tracking modules. PostgreSQL owns capacity and booking history. Redis Pub/Sub distributes committed availability changes to the service's WebSocket connections. Keeping the modules together lets a booking, its attribution and its confirmed tracking events share one database transaction.

| Record | Responsibility and important rules |
| --- | --- |
| Account | Unique email, display name, creation time and immutable signup acquisition/generation. An account can host and book. An account acquired directly starts at generation 0. |
| Activity | Host, title, description, start and end instants, country, display timezone, price/currency, capacity, booked count and increasing availability version. The display timezone follows from the country. Store money in integer minor units and both instants in UTC. |
| Plan | Unique activity reference and shared itinerary. One activity has one plan. |
| Booking | Account, activity, plan and confirmation time. A unique account/activity key prevents duplicate spots. References ensure the plan belongs to the booked activity. |
| Invitation | Unpredictable code, activity/plan, inviter, vouch/public type, optional vouch recipient email, generation and creation time. Its booking deadline follows the activity start. A public invitation is reusable and associated with its sharing account. |
| Booking attribution | One immutable source per booking: the redeemed invitation and inviter/type/code/generation snapshots, or an explicit direct source. A vouch can produce only one successful redemption. |
| Tracking event | Append-only event ID, timestamp, account/visitor and relevant activity, booking or invitation IDs, channel, outcome and experiment assignment. Confirmed outcomes have unique deduplication keys. |
| Experiment assignment | Activity, experiment version, assigned arm and assignment time. The assignment is saved before invitation controls are exposed. |

Database constraints enforce positive capacity, nonnegative prices, a booked count within capacity, structural references and booking uniqueness. The booking transaction maintains consistency between the capacity counter and booking rows.

Email entry resolves an existing account or creates one. New-account acquisition is recorded after validating the invitation context and, for a vouch, its recipient. The API checks the acting account against activity ownership and recipient rules. Email ownership verification is a prototype assumption; production sign-in must establish that ownership.

### 2.2 Booking correctness

Use PostgreSQL `READ COMMITTED` with `SELECT ... FOR UPDATE` on the activity row. Competing requests for the same activity wait for the current transaction's capacity decision; unrelated activities proceed independently. PostgreSQL documents these [row-locking semantics](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS).

The booking operation is shared by direct web booking and invitation claiming:

1. Resolve the acting account and validate the request.
2. Begin a transaction and lock the activity.
3. Return an existing account/activity booking if present. A retry must retain its original attribution and place, even if the activity has since sold out or its invitation expired.
4. For a new booking, check the start-time deadline using database time after acquiring the lock. Validate any invitation's activity, recipient and vouch redemption status.
5. Check capacity, increment the booked count and availability version, and insert the booking, its attribution and confirmed events.
6. Commit, then publish the availability update. A rollback leaves all booking-related writes unchanged.

Keep network calls and user interaction outside the lock. A unique booking key and a database-enforced single-redemption constraint provide additional protection against duplicate claims. Configure finite lock/statement timeouts; a timeout rolls back and is recorded as a failed attempt.

The row lock keeps capacity, duplicate and invitation decisions within one clear transaction boundary. An atomic conditional update is a viable alternative, but still needs the surrounding attribution and duplicate checks. Optimistic versioning adds conflict retries. Redis locks add coordination outside the database that ultimately commits the booking.

### 2.3 Live availability and recovery

After a new booking commits, publish its activity ID, availability version, remaining spots and event ID through Redis. Subscribers forward that update to clients watching the activity. Public messages contain counts and versions; the owning host fetches the participant list through its authorized API.

Clients subscribe before fetching their initial database-backed snapshot, then apply the newest version. On disconnection or foreground return, they reconnect and fetch a fresh snapshot. A five-second refresh while the activity is visible also repairs a missed notification when the connection appears healthy.

Redis publication happens after commit with a finite timeout. If publication fails, the saved booking remains confirmed. A process can also stop between committing and publishing. Redis Pub/Sub provides [at-most-once delivery](https://redis.io/docs/latest/develop/pubsub/), so missed notifications are not replayed. Snapshot refresh repairs another screen's stale count once the API is reachable. Publication failures and delayed recovery remain visible in the latency results.

The two-second p95 target applies to the normal live-update path and includes observed breaches; the five-second fallback does not satisfy that target by itself. Durable publication through a transactional outbox is a possible follow-up if measured failures justify it.

### 2.4 Immutable attribution and invitation generation

The server derives inviter, invitation type, recipient and generation from saved invitation records. Clients cannot supply a different trust classification or rewrite a booking's source.

Invitation creation requires the activity's host or a confirmed booker and an enabled treatment assignment. The public-copy action retrieves an existing link or creates that account's reusable invitation without a separate Generate step.

Preserve two distinct histories:

- **Account acquisition:** how the person first joined Velio, with its original invitation and generation.
- **Booking attribution:** how a particular booking happened, including a later invitation or direct discovery.

For example, someone may join through a kayaking vouch, then book a tour through another person's public link. Their signup source stays the kayaking vouch; the tour booking records the public invitation.

An invitation snapshots the inviter's signup generation plus one. A newly acquired account receives that generation at creation. Returning accounts keep their original acquisition and generation. An invited person's next invitation can therefore acquire the following generation without rewriting earlier history.

Use restrictive database grants and rejecting update/delete triggers for committed attribution and acquisition fields. Keep migration privileges separate and prevent cascading deletion of acquisition history. Record invitation creation and redemption timestamps so the stored relationship can be audited.

Generating a public invite creates the sharing account's reusable public invitation, or returns it if it already exists. Its link is then shown with Copy. Generating remains available when the activity is full; the landing page explains whether a new booking is possible.

### 2.5 Rollout and feature control

Persist an activity's experiment assignment before exposing invitations, and enforce it in the API as well as the interface. Treatment permits both invitation types; control retains ordinary discovery and booking. A creation switch stops new invitations while issued links continue to resolve under their existing booking rules.

Start with internal activities, then a small treatment allocation such as 10%, expanding to 50/50 after booking integrity, attribution, recovery and latency checks. Keep assignments stable when allocations change and record the allocation version. Section 4.4 defines the holdout analysis.

### 2.6 Risks and validation

| Risk | Response and evidence |
| --- | --- |
| Popular activities create lock contention | Keep transactions short, use finite timeouts, and report lock-wait failures alongside booking outcomes. |
| A booking succeeds but confirmation is lost | Look up the account's saved booking before offering a retry; return the same booking without another spot or conversion. |
| Redis publication or connectivity fails | Preserve the database result, expose degraded live updates, and repair visible state with snapshots. Report the resulting delay. |
| Recipient or acquisition history becomes misleading | Validate recipient binding, derive attribution server-side, enforce immutability in the database, and deduplicate returning-account activity. |
| Prototype access is treated as production authentication | Document the email-ownership assumption and replace the shortcut with verified sign-in before public deployment. |
| Synthetic traffic is mistaken for product evidence | Label seeds and test traffic, report sample sizes, and separate test results from real cohorts. |

The required concurrency test releases 50 distinct accounts against one remaining spot through real HTTP requests and PostgreSQL connections. It must show one new booking, graceful rejection of the other claims, matching booked counts and intact attribution. Repeat for several remaining spots and concurrent retries from the same account.

Focused checks cover rollback, vouch recipient mismatch and single redemption, public reuse, immutable history, returning-account generation, and lost-confirmation recovery. Cross-client checks verify that web and Flutter apply the same activity changes; mobile checks cover invitation routing, code entry, cached offline details and refresh before claiming.

A declared load run reports request counts, concurrency, connected viewers, failures, acknowledgement coverage and p95 latency. These measurements establish the result for that workload; numerical results are reported after execution.

## 3. Product implementation plan

### 3.1 People, activity information and account access

Hosts create activities and want people to join them. Bookers choose an activity, secure a spot and bring friends. Invited guests need enough context to decide whether to join, followed by a short path to confirmation.

The activity page shows its description, itinerary, date and time, country, price and remaining spots, together with the host's name, summary and previous activities. Times are shown in the activity's timezone, with its GMT offset when that differs from the viewer's. The Plan is the shared itinerary that bookers join. A successfully booked guest becomes a booker using the same account.

The prototype has a horizontal Host / Booker / Guest selector on web. Host and Booker open seeded accounts with activities and bookings respectively. Guest provides email sign-in to another account, including one created on mobile; signing out returns to Sign in. These are access shortcuts for accounts with the same hosting and booking capabilities.

On mobile, an invitation can be previewed while signed out. Email entry at checkout creates an account for a new email or signs into an existing account. The app retains that account until sign-out. A separate Sign in action lets someone return to an earlier account and its saved bookings.

### 3.2 Host journey on web

1. Create an activity with its title, description, itinerary, future date and start time, end time, country, capacity, price and currency. The country sets the activity's timezone. Preserve entered information and show field-specific validation errors.
2. Publish it and open its activity page. Show the booked count, remaining spots and booked participants' names and masked emails.
3. Watch bookings update without manual refresh. These records show who booked; physical attendance remains a separate, unimplemented capability.
4. Invite from the activity page: enter someone's email to create a personal invitation and share its link, or generate the reusable public invite and copy its link for general sharing.

Hosting itself consumes no bookable spot. If the host books through the same account, that booking uses capacity under the ordinary rules.

### 3.3 Booker journey on web

1. Browse activities and review the activity, itinerary, host, price and availability.
2. Continue to checkout. Use the signed-in account, or enter an email to create/open an account while preserving the activity.
3. Confirm the booking. Optimistically show a pending booking and prevent repeated button submission. Replace it with the saved confirmation on success, or remove the pending state and refresh availability on failure. Confirm the spot after the server saves it.
4. Show the saved booking on the activity page, followed by the activity's details and an invite card with two sharing actions: invite someone you can vouch for, and generate a public invite.
5. For a vouch, enter the intended recipient's email and share the generated invitation. For public sharing, generate the reusable attributed link, then copy it.
6. Return to the activity or saved booking later. Repeating a confirmed booking returns the existing spot.

### 3.4 Invited guest journey in the mobile app

1. Open an invitation link in the installed app or enter its code. An invitation link also provides a responsive browser preview; retain the invitation when continuing into the app. Localhost HTTP is sufficient for development verification. HTTPS delivery is deployment follow-up.
2. Read the activity, itinerary, host information, inviter, price and availability before entering account details.
3. Continue to checkout. If signed out, enter an email; the same step creates a new account or opens the existing one. A signed-in guest uses their current account.
4. For a vouch, match the account email to the intended recipient. If it differs, explain that the invitation was sent to another email and allow the guest to change account. Public invitations have no recipient-email restriction.
5. Confirm using the shared booking operation. Show the pending state immediately, then the saved booking and a success haptic where supported. Reconcile the pending state on failure.
6. Retain the signed-in account and booking. Sign out to use another account, or use Sign in later to return to an earlier booking.

The app caches previously loaded activity details and their fetch time for offline reading. Booking always requires a connection and a fresh validity/capacity check.

### 3.5 Loading, failure and recovery states

| Situation | Experience |
| --- | --- |
| Details are loading or cannot be fetched | Show progress, retain the activity/code and provide Retry. Availability stays unknown until loaded. |
| The last spot is taken during checkout | Explain that the activity just filled before confirmation, refresh availability and retain the activity details. |
| An invitation leads to a full activity | Keep details readable and show that no spots remain. Full capacity is distinct from an expired invitation. |
| The booking deadline has passed | Keep useful activity details readable and explain that bookings have closed. |
| A code is unrecognized | Explain that the invitation could not be found and allow correction. |
| A vouch is claimed with another email | Explain the recipient-email mismatch. Do not consume the invitation or a spot. |
| A vouch recipient revisits after booking | Show the existing booking, including after the invitation expires. Another person cannot redeem that vouch. |
| A public link is reused | Different people can claim while booking is open and capacity remains. Existing bookers see their saved booking. |
| Confirmation does not reach the screen | Show that the booking is being checked and look up the saved result. Offer retry when absence is established; remain unconfirmed while the server is unreachable. |
| The guest is offline | Show previously cached details with an out-of-date availability indication, or retain an uncached code for retry. Refresh before allowing confirmation. |
| Live updates disconnect | Show reconnecting feedback and refresh saved state after reconnecting. Apply newer versions and discard older ones. |

### 3.6 Build now, follow-up and limitations

| Build now | Follow-up |
| --- | --- |
| Host activity creation with description and shared itinerary; host background and booked-participant view | Editing/cancelling published activities with rules for existing bookers. |
| One-spot bookings, concurrency protection, email-based account entry and safe retries | Verified sign-in and production abuse controls. |
| Vouch and public sharing, immutable acquisition/booking attribution and invitation generations | Inviter-facing invitation history showing claim status and claimant. |
| Flutter link/code entry, preview, checkout, saved bookings, haptics and offline detail caching | Desktop invitation claiming after the mobile journey; verified HTTPS links, installation handoff and invitation creation inside the mobile app. |
| Start-time booking closure and deadline-based invitation expiry | Host-configured earlier booking deadlines. |
| Live availability, focused verification, technical metrics, product queries and invitation feature control | A real-cohort experiment and operational alerting. |
| Sold-out and closed-booking states | Booking cancellation and a waiting list that fills cancelled spots in order. |

Payment processing, full authentication, trust scores and host verification remain outside the build. Prices are displayed normally; checkout confirms without charging. Elaborate booking-spam controls are deferred while capacity correctness and duplicate prevention remain essential.

**Attendance and completion limitation.** The requested live-attendance view and measurement of plans that actually happen are not implemented. Their confirmation mechanism needs product agreement. The host sees live bookings, and the tracking plan does not treat bookings or elapsed time as attendance/completion evidence.

**Mobile entry limitation.** Link/code routing is demonstrated with an installed Flutter app. Store installation, deferred-link handoff and domain verification are separate follow-up work; no store publication is required for the prototype.

**Material planning revisions.** Email-based account entry and recipient binding replace the initial demo-contact selection design. Plan now explicitly represents the shared itinerary. Public sharing has a separate Generate step that creates the reusable public link, which is then copied. Hosts choose a country rather than a timezone, and the activity's timezone follows from the country. The initial host-completion proposal is removed pending an operational definition, and Flutter claiming takes priority over desktop claiming. These revisions change the planned journeys and measurement commitments.

## 4. Tracking implementation plan

### 4.1 Goals, measurement and improvement triggers

Report each result with its numerator, denominator or sample count, observation window and relevant breakdowns. Separate synthetic data from real cohorts.

| Goal | Metric and measurement | Target | Improvement trigger |
| --- | --- | --- | --- |
| Never oversell | Count activities whose confirmed bookings exceed capacity; reconcile stored booked count with actual booking rows. | Zero oversold bookings. | Any oversell or mismatch triggers investigation and suspension of new bookings for the affected activity. |
| Bookings succeed when spots exist | Successful eligible attempts for a new booking divided by eligible attempts. Assess account, invitation, deadline and capacity at the locked decision. Report replays, expected sell-outs and invalid requests separately; unexplained errors with unknown availability count as failures until classified. | At least 99.5%. | A declared test run or reporting interval below 99.5%; inspect error categories and lock waits. |
| Availability feels live | For each booking, measure applied state across expected viewing clients; take that booking's slowest viewer, then p95 across bookings. Retain late and missing acknowledgements. | p95 at most 2 seconds. | p95 above 2 seconds or a missing expected acknowledgement. |
| Bookers become inviters | Distinct cohort bookers creating an invitation for their cohort-entry booked activity divided by all distinct cohort bookers. Generating a public invite for the first time qualifies; page display does not. | At least 30%. | A completed seven-day treatment cohort below 30%; inspect action exposure, sharing and capacity. |
| Opened invitations become claims | Distinct person/visitor-invitation pairs producing a new attributed booking divided by opened pairs with complete observation windows. Include and segment full/expired landings. | At least 25%. | A completed seven-day treatment cohort below 25%; inspect invitation type, client, landing state, account entry and booking outcome. |
| K-factor by invitation type | Newly acquired accounts directly attributed to a fixed existing-inviter cohort, separated by vouch/public, divided by everyone in that cohort, including non-inviters. | No numerical target supplied. | A completed cohort below the preceding cohort, or acquired accounts failing to progress to booking; inspect counts and uncertainty. |
| Plans that actually happen | Unmeasured pending a definition of attendance/occurrence evidence and how it is collected. Booking totals remain an intermediate outcome. | No numerical target supplied. | Resolve the operational definition before assessing this outcome or using it to judge experiment success. |

For inviter adoption, each distinct booker enters once at their first treatment-activity booking in the seven-day cohort. Observe invitation creation for that activity for up to 24 hours, ending at activity start. Include people who booked the final spot; public sharing remains accessible.

For open-to-claim conversion, enter each person/visitor-invitation pair at its first displayed open. Observe for up to 24 hours or the booking deadline, whichever comes first. A full or already-expired landing remains an observed outcome. Evaluate the cohort after its observation windows end.

For K-factor, snapshot accounts that existed at cohort start and already hosted or held a booking on a treatment activity. Count newly acquired accounts during the cohort whose signup invitation points to that existing-inviter cohort. Use the same denominator for both invitation types; accounts acquired during this period belong to a later inviter cohort.

Report sample sizes and uncertainty alongside rates. A small or empty cohort cannot establish that a production target has been met.

### 4.2 Events and attribution of outcomes

| Event | Source and meaning |
| --- | --- |
| `activity_viewed` | Client: activity details have been displayed, with web/mobile channel. |
| `booking_attempted` | Server: each received attempt, with an attempt ID and an operation ID linking retries. |
| `booking_confirmed`, `booking_sold_out`, `booking_failed` | Server: saved outcome or failure category. Distinguish a new booking from replaying an existing result. |
| `invite_created` | Server: a vouch is created, or the first Generate creates the sharing account's public invitation. Include type, inviter, activity, code reference and generation. |
| `invite_share_action` | Client: copy/share action and method. Repeat actions are separate from invitation creation; they do not prove delivery. |
| `invite_opened` | Client: a resolved invitation preview has been displayed, including its available/full/expired state. Link-preview metadata requests do not count as opens. |
| `claim_started` | Client: the guest explicitly continues toward checkout. |
| `account_entry_completed` | Server: email-based account entry completed, distinguishing new and returning accounts. |
| `user_created` | Server: the first account creation with its immutable acquisition source and generation. |
| `spot_claimed` | Server: a new invite-attributed booking committed, deduplicated by booking ID. |
| `availability_applied` | Client: the new activity version is displayed after rendering, including whether it arrived through WebSocket or snapshot recovery. |

Record confirmed booking, attribution and conversion outcomes transactionally. Give client events unique IDs and a persistent anonymous visitor ID, preserve the visit reference through web-to-app handoff, then link pre-sign-in activity to the account after account entry. Deduplicate opens by known person/visitor plus invitation, and count a booking conversion once. Cross-device identity that cannot be established remains a measurement limitation.

Repeated sign-ins do not create new users. Reopening or retrying a confirmed booking does not create another conversion. If someone opens different invitations, only the invitation actually redeemed receives the booking attribution. Keep raw emails out of general event properties.

### 4.3 Technical evidence and reporting

Expose booking attempts/outcomes, lock failures, Redis publication failures, rendered-availability latency and missing acknowledgements through `/metrics`. Show raw attempts and logical booking operations separately: a successful retry does not erase an earlier failed attempt.

For latency, save the event time in PostgreSQL immediately before commit and acknowledgement arrival using the same database wall clock. A client acknowledges after applying the committed version to its screen. The interval includes commit work and acknowledgement travel, providing a conservative upper bound on commit-to-display time.

Capture clients subscribed and viewing the activity when the booking begins. Take the slowest expected client's interval for that booking, then p95 across bookings. Retain breaches when a client disconnects or a later snapshot repairs the display. Report coverage, missing/late updates and WebSocket-versus-refresh recovery rather than dropping those observations.

Provide runnable SQL for inviter adoption, opened-invitation conversion and K-factor by invitation type. Each query accepts cohort boundaries and reports numerator, denominator and zero-denominator handling, with breakdowns by invitation type, web/mobile and landing state. Label test fixtures and select them explicitly for demonstration.

### 4.4 Invitation holdout design

Randomly assign whole activities to treatment or control before invitation exposure and keep assignments stable. Treatment enables vouch and public invitations; control retains ordinary discovery and booking. Analyze all assigned activities, including those where nobody invites, and compare booked participants per activity as an intermediate outcome. To establish an effect on plans that actually happen, first agree and instrument occurrence evidence, then define the observation window and calculate sample size from baseline data and the smallest worthwhile improvement. Report assignment version, group sizes, absolute differences and uncertainty, and record people exposed to both arms because social effects can cross activities. Vouch-versus-public comparisons remain descriptive because people choose the invitation type. Prototype assignments and synthetic cohorts demonstrate the design; the actual-occurrence effect remains unmeasured.
