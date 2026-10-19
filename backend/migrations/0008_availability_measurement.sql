-- Ticket #11: applied-availability measurement (PLANS.md 3.4/4.2). Two
-- server-owned facts, both persisted so evidence survives process and Redis
-- loss: which measurement-registered live connections are present and visible
-- per activity (DB-backed ownership so capture spans API instances), and the
-- expected-viewer set captured at booking start with its commit-clock origin,
-- closed later by the first qualifying acknowledgement.

CREATE TABLE live_connections (
  connection_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The API instance that owns the websocket; leases make a crashed
  -- instance's rows stop counting as present without any delete.
  instance_id text NOT NULL CHECK (length(instance_id) BETWEEN 1 AND 128),
  registered_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz NOT NULL
);

-- One row per connection/activity pair, retained after unsubscribe or
-- disconnect (active flips false) so captured history keeps its context.
CREATE TABLE live_presence (
  connection_id uuid NOT NULL REFERENCES live_connections(connection_id),
  activity_id uuid NOT NULL REFERENCES activities(id),
  -- The client's visibility report; presence ownership stays server-side.
  visible boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, activity_id)
);

CREATE INDEX live_presence_activity_idx ON live_presence (activity_id, active, visible);

-- The captured expected-viewer set for one committed booking update, one row
-- per expected viewer. measured_at is clock_timestamp() evaluated in the
-- booking transaction immediately before COMMIT (PLANS 4.2: the interval is
-- an upper bound that includes commit work and acknowledgement travel).
CREATE TABLE availability_measurements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id),
  activity_id uuid NOT NULL REFERENCES activities(id),
  -- Availability version as a string: versions are monotonic bigints and
  -- every public frame carries them as strings (safe bigint representation).
  version text NOT NULL CHECK (version ~ '^[0-9]+$'),
  event_id text,
  connection_id uuid NOT NULL REFERENCES live_connections(connection_id),
  measured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  acked_at timestamptz,
  ack_source text CHECK (ack_source IN ('websocket', 'snapshot')),
  ack_reason text CHECK (ack_reason IN ('interval', 'reconnect', 'foreground')),
  ack_applied_version text CHECK (ack_applied_version IS NULL OR ack_applied_version ~ '^[0-9]+$'),
  closed_at timestamptz,
  UNIQUE (connection_id, activity_id, version)
);

CREATE INDEX availability_measurements_booking_idx ON availability_measurements (booking_id);
CREATE INDEX availability_measurements_open_idx ON availability_measurements (activity_id, connection_id, acked_at);

-- Evidence rows are never erased, and a measurement closes exactly once: the
-- first qualifying acknowledgement writes the ack columns, and no later ack,
-- older version or duplicate can rewrite them (PLANS 4.2: a two-second
-- breach is permanent even if repaired). The identity columns captured at
-- booking start are immutable for every role; the migration role must
-- explicitly disable the trigger for a bounded correction.
CREATE OR REPLACE FUNCTION reject_measurement_rewrite() RETURNS trigger AS $$
BEGIN
  IF NEW.booking_id IS DISTINCT FROM OLD.booking_id
     OR NEW.activity_id IS DISTINCT FROM OLD.activity_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
     OR NEW.measured_at IS DISTINCT FROM OLD.measured_at THEN
    RAISE EXCEPTION 'captured measurement identity is immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.acked_at IS NOT NULL AND
     (NEW.acked_at IS DISTINCT FROM OLD.acked_at
      OR NEW.ack_source IS DISTINCT FROM OLD.ack_source
      OR NEW.ack_reason IS DISTINCT FROM OLD.ack_reason
      OR NEW.ack_applied_version IS DISTINCT FROM OLD.ack_applied_version
      OR NEW.closed_at IS DISTINCT FROM OLD.closed_at) THEN
    RAISE EXCEPTION 'a closed measurement is never rewritten'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER measurement_close_once
  BEFORE UPDATE ON availability_measurements
  FOR EACH ROW EXECUTE FUNCTION reject_measurement_rewrite();

-- Presence and connections are operational rows the application legitimately
-- updates (visibility, liveness leases, close-out), but nothing may erase
-- captured history. DELETE is refused for every role below; the application
-- role additionally holds no DELETE via this revoke.
REVOKE DELETE ON live_connections, live_presence, availability_measurements FROM velio_app;
