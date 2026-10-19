-- Ticket #5: saved invitation-experiment assignments (PLANS.md 3.6). Every
-- activity carries exactly one random treatment/control assignment decided
-- at creation and immutable thereafter, so completed plans can be compared
-- fairly with ordinary booking. Invite-creation gating itself is applied by
-- the invite routes delivered in tickets #6/#7.

CREATE TABLE activity_experiments (
  activity_id uuid PRIMARY KEY REFERENCES activities(id),
  arm text NOT NULL CHECK (arm IN ('treatment', 'control')),
  experiment_version text NOT NULL CHECK (length(experiment_version) BETWEEN 1 AND 64),
  assigned_at timestamptz NOT NULL DEFAULT now()
);

-- Saved assignments are append-only for the application role (grants) and
-- mutation-rejecting for every role (triggers); the migration role disables
-- the trigger explicitly if a bounded correction is ever required.
REVOKE UPDATE, DELETE ON activity_experiments FROM velio_app;

-- CREATE OR REPLACE: functions survive table drops, so a partially applied
-- earlier attempt must not wedge this migration.
CREATE OR REPLACE FUNCTION reject_activity_experiment_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'saved experiment assignments are immutable'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER activity_experiments_immutable
  BEFORE UPDATE OR DELETE ON activity_experiments
  FOR EACH ROW EXECUTE FUNCTION reject_activity_experiment_mutation();

-- backfill: cover activities created before this table existed, once, while
-- no invitation capability is exposed anywhere: the rollout proposal's
-- initial 10% treatment allocation under the initial version. A changed
-- allocation ships as a new experiment version; saved rows never change.
INSERT INTO activity_experiments (activity_id, arm, experiment_version)
SELECT a.id,
       CASE WHEN random() < 0.1 THEN 'treatment' ELSE 'control' END,
       'rollout-1'
FROM activities a
WHERE NOT EXISTS (SELECT 1 FROM activity_experiments e WHERE e.activity_id = a.id)
ON CONFLICT (activity_id) DO NOTHING;
