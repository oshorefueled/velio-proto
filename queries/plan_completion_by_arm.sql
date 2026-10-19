-- $1/$2: seven-day start-time cohort; $3: as-of; $4: real|demo.
-- Every assigned activity is included, even with no bookings/invitations.
-- Wilson 95% intervals express binomial sampling uncertainty, not causal
-- evidence. Difference bounds use conservative endpoint subtraction.
WITH cohort AS (
  SELECT a.id,a.starts_at,e.arm,e.experiment_version
  FROM activities a
  JOIN users h ON h.id = a.host_id AND h.dataset = $4
  JOIN activity_experiments e ON e.activity_id = a.id
  WHERE a.dataset = $4 AND a.starts_at >= $1::timestamptz AND a.starts_at < $2::timestamptz
    AND a.created_at <= $3::timestamptz AND e.assigned_at <= $3::timestamptz
), exposures AS (
  SELECT DISTINCT c.id,c.arm,c.experiment_version,
         COALESCE(ev.user_id::text,vi.user_id::text,'visitor:' || ev.visitor_id) AS person
  FROM cohort c
  JOIN events ev ON ev.activity_id = c.id
    AND ev.event_name IN ('activity_viewed','invite_opened') AND ev.occurred_at <= $3::timestamptz
  LEFT JOIN visitor_identities vi ON vi.visitor_id::text = ev.visitor_id AND vi.created_at <= $3::timestamptz
  LEFT JOIN users u ON u.id = COALESCE(ev.user_id,vi.user_id)
  WHERE u.id IS NULL OR u.dataset = $4
), mixed AS (
  SELECT experiment_version,COUNT(*) AS people FROM (
    SELECT experiment_version,person FROM exposures WHERE person IS NOT NULL
    GROUP BY experiment_version,person HAVING COUNT(DISTINCT arm) > 1
  ) m GROUP BY experiment_version
), per_activity AS (
  SELECT c.*,
         (p.completed AND p.completed_by = a.host_id AND p.completed_at >= c.starts_at
          AND p.completed_at <= c.starts_at + interval '24 hours'
          AND p.completed_at <= $3::timestamptz) AS in_window,
         (p.completed AND p.completed_by = a.host_id AND p.completed_at > c.starts_at + interval '24 hours'
          AND p.completed_at <= $3::timestamptz) AS late,
         (SELECT COUNT(*) FROM bookings b JOIN users u ON u.id = b.user_id AND u.dataset = $4
          WHERE b.activity_id = c.id AND b.created_at <= $3::timestamptz) AS bookers,
         EXISTS (SELECT 1 FROM exposures ex WHERE ex.id = c.id) AS has_exposure
  FROM cohort c JOIN activities a ON a.id = c.id LEFT JOIN plans p ON p.activity_id = c.id
), summary AS (
  SELECT arm,experiment_version,COUNT(*) AS activities,
         COUNT(*) FILTER (WHERE in_window) AS completed_in_window,
         COUNT(*) FILTER (WHERE late) AS completed_late,
         SUM(bookers) AS confirmed_bookers,AVG(bookers) AS confirmed_bookers_per_activity,
         COUNT(*) FILTER (WHERE NOT has_exposure) AS activities_without_recorded_exposure,
         COUNT(*) FILTER (WHERE in_window)::numeric/COUNT(*) AS completion_rate
  FROM per_activity GROUP BY arm,experiment_version
), intervals AS (
  SELECT s.*,
    GREATEST(0,(completion_rate + 3.8416/(2*activities)
      - 1.96*sqrt(completion_rate*(1-completion_rate)/activities + 3.8416/(4*activities*activities)))
      / (1+3.8416/activities)) AS completion_rate_ci_low,
    LEAST(1,(completion_rate + 3.8416/(2*activities)
      + 1.96*sqrt(completion_rate*(1-completion_rate)/activities + 3.8416/(4*activities*activities)))
      / (1+3.8416/activities)) AS completion_rate_ci_high
  FROM summary s
)
SELECT s.*,c.activities AS control_activities,
       s.completion_rate-c.completion_rate AS absolute_difference_vs_control,
       CASE WHEN s.arm = 'control' THEN 0 ELSE s.completion_rate_ci_low-c.completion_rate_ci_high END AS difference_ci_low,
       CASE WHEN s.arm = 'control' THEN 0 ELSE s.completion_rate_ci_high-c.completion_rate_ci_low END AS difference_ci_high,
       COALESCE(m.people,0) AS mixed_arm_exposed_people,
       (SELECT COUNT(DISTINCT ex.person) FROM exposures ex
        WHERE ex.experiment_version = s.experiment_version AND ex.arm = s.arm) AS recorded_exposed_people,
       (SELECT COUNT(*) FROM exposures ex WHERE ex.experiment_version = s.experiment_version
         AND ex.arm = s.arm AND ex.person IS NULL) AS unknown_identity_exposures,
       $3::timestamptz >= $2::timestamptz + interval '24 hours' AS mature,
       GREATEST(0,EXTRACT(EPOCH FROM ($2::timestamptz + interval '24 hours' - $3::timestamptz))/3600) AS remaining_observation_hours
FROM intervals s
LEFT JOIN intervals c ON c.experiment_version=s.experiment_version AND c.arm='control'
LEFT JOIN mixed m ON m.experiment_version=s.experiment_version
ORDER BY s.experiment_version,s.arm;
