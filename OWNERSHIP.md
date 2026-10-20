## 1. Diagnose: Why don't guests claim?

I’ll check whether guests who didn’t claim arrived after activities had filled up, then compare overall conversion with conversion when spots were available.

- **Availability:** I’ll check failed claims, expired codes and how often activities fill between opening and claiming.
- **Invite type and interest:** I’ll compare opens, conversion and total claims for vouch and public invitations. Views without claim attempts may indicate low interest.
- **Mobile experience:** I’ll examine errors, loading times and session replays to understand drop-off, then test on real phones.

## 2. Improve: What I’d change

Since invite creation is above target at 34%, I’d focus on what happens after guests open an invite, in this order:

1. **Tracking: low effort; low direct impact on conversion.** I’d record availability at opening, drop-off steps, loading times and failure reasons by device and invite type.
2. **Mobile friction: potentially high impact; low to medium effort.** I’d fix confirmed problems, preserving invitations when the app opens and entered details during retries if these are being lost.
3. **Reminders: uncertain impact; medium effort.** If delay explains missed spots, I’d test one email reminder for guests who opened a vouch invitation but haven’t claimed. I’d send it while the invitation is valid and spots remain available.

Tracking comes first to guide the fixes; mobile follows because most invitations are opened there.

## 3. Prove: How I’d know the changes worked

I’d randomly assign activities to the improved experience or a **holdout keeping the current experience**, so guests competing for the same spots receive the same version.

- **Conversion:** I’d compare conversion after opening, overall and by invite type, counting repeat opens once per guest and invitation. I’d include sold-out opens, with a separate breakdown when spots were available.
- **Success:** I’d agree sample size and conversion window beforehand. I’d look for positive uplift with a 95% confidence interval above zero, accounting for activity grouping, and check whether conversion reaches 25%.
- **Wider outcome:** I’d check total claims, new users by invite type, and booking and availability SLOs.

Separately, I’d randomly assign activities to invitations enabled or disabled, comparing bookings and new users per activity against the **no-invitation holdout** over the same period. Bookings remain an interim outcome until attendance is measured.

## 4. Decide: What I’d recommend

I’d keep the feature if the holdout confirms additional users or bookings at a reasonable cost, even below 25%. I’d continue iterating where the diagnosis identifies improvements worth the effort; otherwise, monitor it and redirect development.

I’d consider separate conversion targets for vouch and public invitations if supported by evidence. I’d only remove the feature if its costs outweigh its benefits.