-- Ticket #4: bookings and their immutable direct attributions (PLANS.md 3.2).
-- Invited rails extend the attribution CHECK and columns in ticket #6. The
-- plan composite reference makes a booking's plan belong to its activity;
-- unique (activity_id, user_id) makes one booking per person per activity.

-- The unique pair this index backs makes the composite foreign key below
-- enforce that a booking's plan belongs to its activity.
ALTER TABLE plans ADD CONSTRAINT plans_activity_id_id_key UNIQUE (activity_id, id);

CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id uuid NOT NULL REFERENCES activities(id),
  plan_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (activity_id, user_id),
  FOREIGN KEY (activity_id, plan_id) REFERENCES plans (activity_id, id)
);

CREATE INDEX bookings_user_id_idx ON bookings (user_id);

CREATE TABLE booking_attributions (
  booking_id uuid PRIMARY KEY REFERENCES bookings(id),
  rail text NOT NULL CHECK (rail = 'direct'),
  generation integer NOT NULL CHECK (generation = 0),
  claimed_at timestamptz NOT NULL DEFAULT now()
);

-- Committed origins are append-only for the application role (grants) and
-- mutation-rejecting for every role (triggers); the migration role disables
-- the trigger explicitly if a bounded correction is ever required.
REVOKE UPDATE, DELETE ON bookings, booking_attributions FROM velio_app;

-- CREATE OR REPLACE: functions survive table drops, so a partially applied
-- earlier attempt must not wedge this migration.
CREATE OR REPLACE FUNCTION reject_booking_attribution_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'booking attribution history is immutable'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER booking_attributions_immutable
  BEFORE UPDATE OR DELETE ON booking_attributions
  FOR EACH ROW EXECUTE FUNCTION reject_booking_attribution_mutation();
