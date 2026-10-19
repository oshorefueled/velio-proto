-- $1/$2: seven-day half-open cohort; $3: as-of; $4: real|demo.
-- Fixed existing-inviter population, including non-inviters. Hosting begins
-- at publication, not activity start. Both rails and each acquisition-version
-- row use the SAME fixed denominator. Versions never pool acquisitions.
WITH eligible_activities AS (
  SELECT a.*, e.experiment_version, e.assigned_at
  FROM activities a
  JOIN users h ON h.id = a.host_id AND h.dataset = $4
  JOIN activity_experiments e ON e.activity_id = a.id AND e.arm = 'treatment'
  WHERE a.dataset = $4 AND a.created_at < $1::timestamptz
    AND a.created_at <= $3::timestamptz AND e.assigned_at <= $3::timestamptz
    AND e.assigned_at < $1::timestamptz
), cohort_inviters AS (
  SELECT u.id FROM users u
  WHERE u.created_at < $1::timestamptz AND u.created_at <= $3::timestamptz AND u.dataset = $4
    AND (EXISTS (SELECT 1 FROM eligible_activities a WHERE a.host_id = u.id)
      OR EXISTS (SELECT 1 FROM bookings b JOIN eligible_activities a ON a.id = b.activity_id
                 WHERE b.user_id = u.id AND b.created_at < $1::timestamptz AND b.created_at <= $3::timestamptz))
), acquired AS (
  SELECT u.id, i.rail, e.experiment_version,
    EXISTS (SELECT 1 FROM bookings b
            JOIN activities ba ON ba.id = b.activity_id AND ba.dataset = $4
            JOIN users bh ON bh.id = ba.host_id AND bh.dataset = $4
            WHERE b.user_id = u.id AND b.created_at <= $3::timestamptz) AS booked
  FROM users u
  JOIN invites i ON i.id = u.signup_invite_id
  JOIN activities a ON a.id = i.activity_id AND a.dataset = $4
  JOIN users host ON host.id = a.host_id AND host.dataset = $4
  JOIN activity_experiments e ON e.activity_id = a.id AND e.arm = 'treatment'
  WHERE u.dataset = $4 AND u.created_at >= $1::timestamptz
    AND u.created_at < $2::timestamptz AND u.created_at <= $3::timestamptz
    AND i.created_at <= u.created_at AND a.created_at <= u.created_at
    AND e.assigned_at <= u.created_at
    AND i.creator_id IN (SELECT id FROM cohort_inviters)
), versions AS (
  SELECT DISTINCT e.experiment_version
  FROM activities a
  JOIN users h ON h.id = a.host_id AND h.dataset = $4
  JOIN activity_experiments e ON e.activity_id = a.id AND e.arm = 'treatment'
  WHERE a.dataset = $4 AND a.created_at <= $3::timestamptz AND e.assigned_at <= $3::timestamptz
  UNION ALL SELECT '(none)' WHERE NOT EXISTS (
    SELECT 1 FROM activities a JOIN users h ON h.id = a.host_id AND h.dataset = $4
    JOIN activity_experiments e ON e.activity_id = a.id AND e.arm = 'treatment'
    WHERE a.dataset = $4 AND a.created_at <= $3::timestamptz AND e.assigned_at <= $3::timestamptz)
), denominator AS (SELECT COUNT(*) AS cohort_inviters FROM cohort_inviters)
SELECT v.experiment_version, r.rail, d.cohort_inviters,
       COUNT(a.id) AS acquired_users,
       COUNT(a.id) FILTER (WHERE a.booked) AS acquired_users_who_booked,
       COUNT(a.id) FILTER (WHERE a.booked)::numeric / NULLIF(COUNT(a.id),0) AS acquired_booked_share,
       COUNT(a.id)::numeric / NULLIF(d.cohort_inviters,0) AS k_factor,
       $3::timestamptz >= $2::timestamptz AS mature,
       GREATEST(0, EXTRACT(EPOCH FROM ($2::timestamptz - $3::timestamptz))/3600) AS remaining_observation_hours,
       $3::timestamptz AS as_of
FROM versions v CROSS JOIN (VALUES ('public_share'), ('vouch')) r(rail)
CROSS JOIN denominator d
LEFT JOIN acquired a ON a.rail = r.rail AND a.experiment_version = v.experiment_version
GROUP BY v.experiment_version,r.rail,d.cohort_inviters
ORDER BY v.experiment_version,r.rail;
