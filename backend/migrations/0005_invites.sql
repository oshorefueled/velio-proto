-- Ticket #6: reusable public share links and the permanent invite/attribution
-- origin records they write (PLANS.md 3.2, US-06/07/08/10). The vouch rail
-- extends the rail CHECKs and adds target matching in ticket #7 on this same
-- foundation; no second mechanism is created here.

CREATE TABLE invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The typeable form of the invite: uppercase Crockford base32 from the
  -- application's cryptographic random source; uniqueness is enforced here,
  -- unpredictability there. Codes are never sequenced or derived.
  code text NOT NULL UNIQUE CHECK (code ~ '^[0-9A-HJKMNP-TV-Z]{8,32}$'),
  rail text NOT NULL CHECK (rail = 'public_share'),
  creator_id uuid NOT NULL REFERENCES users(id),
  activity_id uuid NOT NULL REFERENCES activities(id),
  plan_id uuid NOT NULL,
  FOREIGN KEY (activity_id, plan_id) REFERENCES plans (activity_id, id),
  -- Immutable snapshot of the inviter's signup generation plus one.
  generation integer NOT NULL CHECK (generation >= 1),
  -- Invites expire no later than the activity start (USER_STORIES.md).
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

-- Creation-time records are append-only for the application role (grants)
-- and mutation-rejecting for every role (triggers); the migration role
-- disables the trigger explicitly if a bounded correction is ever required.
REVOKE UPDATE, DELETE ON invites FROM velio_app;

-- CREATE OR REPLACE: functions survive table drops, so a partially applied
-- earlier attempt must not wedge this migration.
CREATE OR REPLACE FUNCTION reject_invite_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'saved invites are immutable'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER invites_immutable
  BEFORE UPDATE OR DELETE ON invites
  FOR EACH ROW EXECUTE FUNCTION reject_invite_mutation();

-- Booking attribution carries the invite's saved origin: inviter, rail, code
-- and generation are server-derived snapshots, never client-supplied values
-- (PLANS.md 3.1). Direct rows keep every invite column null.
ALTER TABLE booking_attributions DROP CONSTRAINT booking_attributions_rail_check;
ALTER TABLE booking_attributions DROP CONSTRAINT booking_attributions_generation_check;
ALTER TABLE booking_attributions
  ADD COLUMN inviter_id uuid REFERENCES users(id),
  ADD COLUMN invite_id uuid REFERENCES invites(id),
  ADD COLUMN code text,
  ADD CONSTRAINT booking_attributions_rail_check CHECK (rail IN ('direct', 'public_share')),
  ADD CONSTRAINT booking_attributions_origin_check CHECK (
    (rail = 'direct' AND generation = 0
      AND inviter_id IS NULL AND invite_id IS NULL AND code IS NULL)
    OR (rail = 'public_share' AND generation >= 1
      AND inviter_id IS NOT NULL AND invite_id IS NOT NULL AND code IS NOT NULL)
  );

-- Signup acquisition records the first valid invite used at identity
-- creation and never changes afterwards (PLANS.md 3.2).
ALTER TABLE users DROP CONSTRAINT users_signup_source_check;
ALTER TABLE users DROP CONSTRAINT users_signup_generation_check;
ALTER TABLE users
  ADD COLUMN signup_invite_id uuid REFERENCES invites(id),
  ADD CONSTRAINT users_signup_source_check CHECK (signup_source IN ('direct', 'public_share')),
  ADD CONSTRAINT users_signup_origin_check CHECK (
    (signup_source = 'direct' AND signup_generation = 0 AND signup_invite_id IS NULL)
    OR (signup_source = 'public_share' AND signup_generation >= 1 AND signup_invite_id IS NOT NULL)
  );

-- The application role already holds no UPDATE on users (0001); this trigger
-- keeps the origin columns unrewritable for every role, including the
-- migration role unless it explicitly disables the trigger.
CREATE OR REPLACE FUNCTION reject_signup_origin_mutation() RETURNS trigger AS $$
BEGIN
  IF NEW.signup_source IS DISTINCT FROM OLD.signup_source
     OR NEW.signup_generation IS DISTINCT FROM OLD.signup_generation
     OR NEW.signup_invite_id IS DISTINCT FROM OLD.signup_invite_id THEN
    RAISE EXCEPTION 'signup acquisition history is immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER signup_origin_immutable
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION reject_signup_origin_mutation();

-- No destructive cascades: every foreign key above uses the default
-- NO ACTION, so removing an activity, plan, user or booking that history
-- references is refused rather than silently erasing attribution
-- (PLANS.md 3.2: "No cascading deletion may erase that history").
