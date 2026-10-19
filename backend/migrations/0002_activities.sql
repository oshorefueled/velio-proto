-- Ticket #3: independently bookable activities and their unique shared plans
-- (PLANS.md 3.2). booked_count transitions arrive with ticket #4; host
-- completion behavior with ticket #8, whose columns exist here because the
-- plans table is declared once. Remaining spots are derived
-- (capacity - booked_count) and never stored (CONTEXT.md: Availability is
-- derived, never recorded on its own terms).

CREATE TABLE activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  starts_at timestamptz NOT NULL,
  display_timezone text NOT NULL CHECK (length(display_timezone) BETWEEN 1 AND 64),
  price_minor_units bigint NOT NULL CHECK (price_minor_units >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  capacity integer NOT NULL CHECK (capacity > 0),
  booked_count integer NOT NULL DEFAULT 0 CHECK (booked_count >= 0 AND booked_count <= capacity),
  availability_version bigint NOT NULL DEFAULT 1 CHECK (availability_version >= 1),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX activities_starts_at_idx ON activities (starts_at);

CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id uuid NOT NULL UNIQUE REFERENCES activities(id),
  completed boolean NOT NULL DEFAULT false,
  completed_by uuid REFERENCES users(id),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (completed = false OR (completed_by IS NOT NULL AND completed_at IS NOT NULL))
);
