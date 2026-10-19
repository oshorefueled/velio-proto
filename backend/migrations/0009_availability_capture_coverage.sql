-- Distinguish an observed empty viewer set from lost measurement evidence.
CREATE TABLE availability_captures (
  booking_id uuid PRIMARY KEY REFERENCES bookings(id),
  measured_at timestamptz NOT NULL,
  expected_viewers integer NOT NULL CHECK (expected_viewers >= 0),
  capture_succeeded boolean NOT NULL
);
REVOKE UPDATE, DELETE ON availability_captures FROM velio_app;
