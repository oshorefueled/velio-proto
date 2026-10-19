-- Ticket #10: the smallest durable server-owned relationship between a
-- persistent anonymous visitor ID and the identity a session resolved for it
-- (PLANS.md 4.1: "Link that visitor to the selected user ID once identity
-- selection finishes"). Append-only client observations keep living in the
-- events log; this table only reconciles earlier observations with later
-- claims, never rewriting them.

CREATE TABLE visitor_identities (
  -- The client-generated canonical UUID persisted on the visitor's device.
  -- Correlation only: not a credential and not a person guarantee (PLANS.md
  -- 4.1: an unknown person on unrelated devices cannot be assumed the same).
  visitor_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  channel text CHECK (channel IN ('web', 'flutter')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX visitor_identities_user_id_idx ON visitor_identities (user_id);

-- A link is written once and never reassigned: ON CONFLICT DO NOTHING in the
-- service makes the first resolved identity win, and the application role can
-- never UPDATE or DELETE its way around that (US-10 mutation denial).
REVOKE UPDATE, DELETE ON visitor_identities FROM velio_app;
