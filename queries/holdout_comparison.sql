-- $1/$2: seven-day start-time cohort; $3: as-of; $4: real|demo.
-- Activity-level holdout (SPEC 6): every activity with a saved arm that
-- starts in the cohort, including those with no bookings or inviters. The
-- outcome is booked participants per assigned activity, an intermediate
-- outcome: actual occurrence/attendance is not measured. Booking closes at
-- start, so the cohort is mature once its last activity can have started.
-- Intervals are normal approximations of sampling uncertainty (mean +/-
-- 1.96 SE; difference uses unpooled SEs), not causal proof.
WITH cohort AS (
  SELECT a.id, a.host_id, a.starts_at, e.arm, e.experiment_version
  FROM activities a
  JOIN users h ON h.id = a.host_id AND h.dataset = $4
  JOIN activity_experiments e ON e.activity_id = a.id
  WHERE a.dataset = $4 AND a.starts_at >= $1::timestamptz AND a.starts_at < $2::timestamptz
    AND a.created_at <= $3::timestamptz AND e.assigned_at <= $3::timestamptz
), account_entries AS (
  SELECT ae.user_id, ae.visitor_id, ae.details->>'visitId' AS visit_id, ae.occurred_at
  FROM events ae
  WHERE ae.event_name = 'account_entry_completed' AND ae.user_id IS NOT NULL
    AND ae.occurred_at <= $3::timestamptz
), exposures AS (
  -- The person exposed to an arm, resolved as invite_conversion does: the
  -- explicit account, the account entered in the same visit, or (without a
  -- visit) the next account on the device within 24 hours; else the device.
  -- An exposure with neither account nor device has a NULL person.
  SELECT DISTINCT c.id, c.arm, c.experiment_version, ev.event_id,
         COALESCE(
           ev.user_id::text,
           (SELECT en.user_id::text FROM account_entries en
            WHERE ev.details->>'visitId' IS NOT NULL AND en.visit_id = ev.details->>'visitId'
              AND en.occurred_at >= ev.occurred_at
            ORDER BY en.occurred_at LIMIT 1),
           (SELECT en.user_id::text FROM account_entries en
            WHERE ev.details->>'visitId' IS NULL AND ev.visitor_id IS NOT NULL AND en.visitor_id = ev.visitor_id
              AND en.occurred_at >= ev.occurred_at AND en.occurred_at < ev.occurred_at + interval '24 hours'
            ORDER BY en.occurred_at LIMIT 1),
           'visitor:' || ev.visitor_id) AS person
  FROM cohort c
  JOIN events ev ON ev.activity_id = c.id
    AND ev.event_name IN ('activity_viewed', 'invite_opened') AND ev.occurred_at <= $3::timestamptz
  LEFT JOIN users u ON u.id = ev.user_id
  WHERE u.id IS NULL OR u.dataset = $4
), mixed AS (
  SELECT experiment_version, COUNT(*) AS people FROM (
    SELECT experiment_version, person FROM exposures WHERE person IS NOT NULL
    GROUP BY experiment_version, person HAVING COUNT(DISTINCT arm) > 1
  ) m GROUP BY experiment_version
), per_activity AS (
  SELECT c.*,
         (SELECT COUNT(*) FROM bookings b JOIN users u ON u.id = b.user_id AND u.dataset = $4
          WHERE b.activity_id = c.id AND b.created_at <= $3::timestamptz) AS booked,
         -- An inviter is a booker of this activity who created an invitation for it.
         EXISTS (SELECT 1 FROM invites i JOIN bookings b ON b.activity_id = i.activity_id AND b.user_id = i.creator_id
                 WHERE i.activity_id = c.id AND i.creator_id <> c.host_id
                   AND i.created_at <= $3::timestamptz AND b.created_at <= $3::timestamptz) AS has_inviter,
         EXISTS (SELECT 1 FROM exposures ex WHERE ex.id = c.id) AS has_exposure
  FROM cohort c
), summary AS (
  SELECT arm, experiment_version, COUNT(*) AS activities,
         SUM(booked) AS booked_participants,
         AVG(booked) AS booked_participants_per_activity,
         STDDEV_SAMP(booked) AS booked_participants_sd,
         STDDEV_SAMP(booked) / sqrt(COUNT(*)) AS booked_participants_se,
         COUNT(*) FILTER (WHERE NOT has_inviter) AS activities_without_inviter,
         COUNT(*) FILTER (WHERE NOT has_exposure) AS activities_without_recorded_exposure
  FROM per_activity GROUP BY arm, experiment_version
)
SELECT s.experiment_version, s.arm, s.activities, s.booked_participants,
       s.booked_participants_per_activity, s.booked_participants_sd,
       s.booked_participants_per_activity - 1.96 * s.booked_participants_se AS booked_participants_ci_low,
       s.booked_participants_per_activity + 1.96 * s.booked_participants_se AS booked_participants_ci_high,
       s.activities_without_inviter, s.activities_without_recorded_exposure,
       c.activities AS control_activities,
       s.booked_participants_per_activity - c.booked_participants_per_activity AS difference_vs_control,
       s.booked_participants_per_activity - c.booked_participants_per_activity
         - 1.96 * sqrt(s.booked_participants_se ^ 2 + c.booked_participants_se ^ 2) AS difference_ci_low,
       s.booked_participants_per_activity - c.booked_participants_per_activity
         + 1.96 * sqrt(s.booked_participants_se ^ 2 + c.booked_participants_se ^ 2) AS difference_ci_high,
       COALESCE(m.people, 0) AS mixed_arm_exposed_people,
       (SELECT COUNT(DISTINCT ex.person) FROM exposures ex
        WHERE ex.experiment_version = s.experiment_version AND ex.arm = s.arm) AS recorded_exposed_people,
       (SELECT COUNT(*) FROM exposures ex WHERE ex.experiment_version = s.experiment_version
         AND ex.arm = s.arm AND ex.person IS NULL) AS unknown_identity_exposures,
       'booked participants per assigned activity' AS outcome,
       'unmeasured' AS actual_occurrence,
       $3::timestamptz >= $2::timestamptz AS mature,
       GREATEST(0, EXTRACT(EPOCH FROM ($2::timestamptz - $3::timestamptz)) / 3600) AS remaining_observation_hours
FROM summary s
LEFT JOIN summary c ON c.experiment_version = s.experiment_version AND c.arm = 'control' AND s.arm <> 'control'
LEFT JOIN mixed m ON m.experiment_version = s.experiment_version
ORDER BY s.experiment_version, s.arm;
