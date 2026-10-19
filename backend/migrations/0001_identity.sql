-- Ticket #2: persistent demo identity (users, opaque sessions) and the
-- append-only event log the tracking plan builds on (PLANS.md 3.2).
-- Invite-based acquisition extends these constraints in ticket #6; no other
-- capability's schema is created here.

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_key text NOT NULL UNIQUE CHECK (length(contact_key) BETWEEN 1 AND 120),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  signup_source text NOT NULL CHECK (signup_source = 'direct'),
  signup_generation integer NOT NULL CHECK (signup_generation = 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE demo_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);

CREATE TABLE events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_name text NOT NULL,
  dedup_key text UNIQUE,
  user_id uuid,
  visitor_id text,
  activity_id uuid,
  plan_id uuid,
  booking_id uuid,
  invite_id uuid,
  channel text,
  outcome text,
  experiment_version text,
  experiment_arm text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX events_user_id_idx ON events (user_id);
CREATE INDEX events_name_occurred_idx ON events (event_name, occurred_at);

-- The application role creates identity records and appends events but never
-- mutates or deletes them: original acquisition history and the event log are
-- append-only for the API (PLANS.md 3.2; US-10 mutation denial).
REVOKE UPDATE, DELETE ON users, demo_sessions, events FROM velio_app;
