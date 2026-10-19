-- Ticket #7: recipient-matched vouch invites on the shared invitation
-- foundation (PLANS.md 3.2, US-05/08/10). A vouch carries one named demo
-- contact; the private target identifier is stored only on the invite row
-- and never exposed through preview or events. One successful redemption per
-- vouch is enforced structurally, including concurrent attempts.

ALTER TABLE invites DROP CONSTRAINT invites_rail_check;
ALTER TABLE invites
  ADD COLUMN target_contact_key text
    CHECK (target_contact_key IS NULL OR length(target_contact_key) BETWEEN 1 AND 120),
  ADD CONSTRAINT invites_rail_check CHECK (
    (rail = 'public_share' AND target_contact_key IS NULL)
    OR (rail = 'vouch' AND target_contact_key IS NOT NULL)
  );

-- A vouch's booking attribution carries the same server-derived snapshots as
-- a public-share claim; the partial unique index makes a second committed
-- redemption of one vouch impossible at the storage layer, for every role
-- and every concurrent writer (PLANS.md 3.2: "a unique partial index allows
-- a vouch invite only one redemption").
ALTER TABLE booking_attributions DROP CONSTRAINT booking_attributions_rail_check;
ALTER TABLE booking_attributions DROP CONSTRAINT booking_attributions_origin_check;
ALTER TABLE booking_attributions
  ADD CONSTRAINT booking_attributions_rail_check CHECK (rail IN ('direct', 'public_share', 'vouch')),
  ADD CONSTRAINT booking_attributions_origin_check CHECK (
    (rail = 'direct' AND generation = 0
      AND inviter_id IS NULL AND invite_id IS NULL AND code IS NULL)
    OR (rail IN ('public_share', 'vouch') AND generation >= 1
      AND inviter_id IS NOT NULL AND invite_id IS NOT NULL AND code IS NOT NULL)
  );

-- Signup acquisition records the vouch's rail and generation exactly like a
-- public share's (PLANS.md 3.2: the saved invite's generation).
ALTER TABLE users DROP CONSTRAINT users_signup_source_check;
ALTER TABLE users DROP CONSTRAINT users_signup_origin_check;
ALTER TABLE users
  ADD CONSTRAINT users_signup_source_check CHECK (signup_source IN ('direct', 'public_share', 'vouch')),
  ADD CONSTRAINT users_signup_origin_check CHECK (
    (signup_source = 'direct' AND signup_generation = 0 AND signup_invite_id IS NULL)
    OR (signup_source IN ('public_share', 'vouch') AND signup_generation >= 1 AND signup_invite_id IS NOT NULL)
  );

CREATE UNIQUE INDEX booking_attributions_vouch_once
  ON booking_attributions (invite_id)
  WHERE rail = 'vouch';

-- No destructive cascades: every foreign key above and below uses the
-- default NO ACTION, so history referenced by invites or attributions cannot
-- be silently erased (PLANS.md 3.2).
