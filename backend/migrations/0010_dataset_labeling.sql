-- Ticket #12: durable, operator-controlled dataset labeling (PLANS.md 4.3:
-- label seeds and test traffic synthetic and exclude them from real-cohort
-- queries by default). Two roots carry the label — people and activities —
-- and every report anchors on them through joins, so the exclusion holds in
-- all denominators and not merely in an event flag. Existing rows default to
-- 'real': unknown historical data is never mass-rewritten; the demo seed
-- labels its own future output.

ALTER TABLE users ADD COLUMN dataset text NOT NULL DEFAULT 'real' CHECK (dataset IN ('real', 'demo'));
ALTER TABLE activities ADD COLUMN dataset text NOT NULL DEFAULT 'real' CHECK (dataset IN ('real', 'demo'));

CREATE INDEX users_dataset_idx ON users (dataset);
CREATE INDEX activities_dataset_idx ON activities (dataset);

-- The label is an operator fact, not a client fact: the application role
-- already holds no UPDATE on users (migration 0001), so no public request
-- can relabel a person; activities.dataset is likewise never written by any
-- API path (only the booking counter is). Seeds and fixtures label through
-- the migration/operator role only.
