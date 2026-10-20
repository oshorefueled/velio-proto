# Demo walkthrough

This is a rehearsal order for presenting the prototype. Setup is in the [README](../README.md#quick-start). It assumes the API on `:3001`, web on `:5174` and an iPhone simulator, with the seed run at 100% treatment.

## Order

1. **Host publishes** on web. Choose **Host** and select **Publish activity**. Enter a title, description, itinerary, a start and end time and timezone, an optional country, spots, and a price in a normal currency. The new activity opens with **0 booked · N remaining** and an empty participant list.
2. **Booker books and invites** on web, in a second browser window. Choose **Booker**, open the activity and select **Book a spot**. Review the checkout and select **Confirm one spot**. Then open **Invite someone to this plan**:
   - **Copy public link** creates the reusable link;
   - **Invite someone** with an email creates a personal invitation for that address.

   The host window updates its count and participants (name + masked email) without a refresh.
3. **Guest previews and claims** on the phone. Run `xcrun simctl openurl booted "velio://invite/<CODE>"` and confirm "Open in Velio". iOS asks for this the first time. The guest sees the activity, itinerary, host, inviter, date, price and availability before any account entry. Select **Continue to checkout**, enter a new email and confirm. One success haptic plays on a physical device; the simulator has no haptics.
4. **Live counts.** With the activity open on web and in the app, book from another account. Both screens update within the live path.
5. **Return.** In the app, Sign out, relaunch, use **Sign in to saved bookings** with the guest email, and open the saved booking without the code.
6. **Offline.** Open an invitation once, then stop the API (or switch the Mac offline) and reopen it. The cached details show with "You are offline · Saved <time>". Claiming says a connection is required. Fill the activity elsewhere and restore the API: the preview refreshes to sold out.
7. **Reports and metrics:**
   - `npm run cohorts -- invite_conversion --start … --end … --dataset demo`, plus `acquisition_audit` to compare acquisition with booking source;
   - `GET /metrics` for booking reliability, oversell and rendered latency.
8. **Holdout and kill switch.** Start a second API with `EXPERIMENT_TREATMENT_ALLOCATION_PERCENT=0 EXPERIMENT_INVITE_CREATION_ENABLED=false PORT=3002`. A new activity there is in control: invitation creation is refused but booking works. Existing invitations still book.

## Resetting

- **Clean database:** `docker compose down -v && docker compose up -d --wait`, then `npm run migrate` and the seed again.
- **Simulator app:** uninstall it, or `xcrun simctl erase <device>`. A fresh install starts signed out.
- **Web account:** use **Sign out**, or clear the site's local storage (`velio.session.v1`).
- **Demo labels:** accounts and activities created through the UI are real data until an operator labels them `demo` (`UPDATE … SET dataset='demo'` as the `postgres` superuser). The application role can't change labels.
