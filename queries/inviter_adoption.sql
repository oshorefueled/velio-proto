-- $1/$2: seven-day half-open cohort; $3: as-of; $4: real|demo.
-- Each person enters at their first treatment booking IN the cohort.
-- Both rails may contribute diagnostics, but a person counts once overall.
-- Only a deliberate invitation creation qualifies; repeat copies of the same
-- public link are share actions, reported separately, and page display alone
-- never counts.
WITH entries AS (
  SELECT DISTINCT ON (b.user_id) b.user_id, b.created_at AS entry_at,
         b.activity_id, a.starts_at,
         LEAST(b.created_at + interval '24 hours', a.starts_at) AS deadline,
         (SELECT (ev.details->>'remainingSpots')::integer FROM events ev
          WHERE ev.event_name = 'booking_confirmed' AND ev.booking_id = b.id
            AND ev.occurred_at <= $3::timestamptz
            AND ev.details->>'remainingSpots' ~ '^[0-9]{1,9}$'
          ORDER BY ev.occurred_at,ev.event_id LIMIT 1) AS remaining_at_entry
  FROM bookings b
  JOIN users u ON u.id = b.user_id AND u.dataset = $4
  JOIN activities a ON a.id = b.activity_id AND a.dataset = $4
  JOIN users host ON host.id = a.host_id AND host.dataset = $4
  JOIN activity_experiments e ON e.activity_id = a.id AND e.arm = 'treatment'
  WHERE b.created_at >= $1::timestamptz AND b.created_at < $2::timestamptz
    AND b.created_at <= $3::timestamptz AND a.created_at <= $3::timestamptz
    AND u.created_at <= $3::timestamptz AND e.assigned_at <= $3::timestamptz
  ORDER BY b.user_id, b.created_at, b.id
), per_entry AS (
  SELECT en.*,
         EXISTS (SELECT 1 FROM invites i WHERE i.creator_id = en.user_id
                 AND i.activity_id = en.activity_id AND i.created_at >= en.entry_at
                 AND i.created_at < en.deadline AND i.created_at <= $3::timestamptz) AS invited,
         EXISTS (SELECT 1 FROM invites i WHERE i.creator_id = en.user_id
                 AND i.activity_id = en.activity_id AND i.created_at >= en.entry_at
                 AND i.created_at < en.deadline AND i.created_at <= $3::timestamptz
                 AND i.rail = 'public_share') AS invited_public_share,
         EXISTS (SELECT 1 FROM invites i WHERE i.creator_id = en.user_id
                 AND i.activity_id = en.activity_id AND i.created_at >= en.entry_at
                 AND i.created_at < en.deadline AND i.created_at <= $3::timestamptz
                 AND i.rail = 'vouch') AS invited_vouch,
         (SELECT COUNT(*) FROM events sa WHERE sa.event_name = 'invite_share_action'
                 AND sa.user_id = en.user_id AND sa.activity_id = en.activity_id
                 AND sa.occurred_at >= en.entry_at AND sa.occurred_at < en.deadline
                 AND sa.occurred_at <= $3::timestamptz) AS share_actions
  FROM entries en
), host_only AS (
  SELECT COUNT(DISTINCT i.creator_id) AS host_only_inviters
  FROM invites i
  JOIN users u ON u.id = i.creator_id AND u.dataset = $4
  JOIN activities a ON a.id = i.activity_id AND a.dataset = $4
  JOIN activity_experiments e ON e.activity_id = a.id AND e.arm = 'treatment'
  WHERE i.creator_id = a.host_id AND i.created_at >= $1::timestamptz
    AND i.created_at < $2::timestamptz AND i.created_at <= $3::timestamptz
    AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.user_id = i.creator_id
                    AND b.activity_id = a.id AND b.created_at <= $3::timestamptz)
)
SELECT $1::timestamptz AS cohort_start, $2::timestamptz AS cohort_end,
       $3::timestamptz AS as_of, $4 AS dataset,
       COUNT(*) AS bookers, COUNT(*) FILTER (WHERE invited) AS inviters,
       COUNT(*) FILTER (WHERE invited)::numeric / NULLIF(COUNT(*), 0) AS adoption_rate,
       COUNT(*) FILTER (WHERE invited_public_share) AS inviters_public_share,
       COUNT(*) FILTER (WHERE invited_vouch) AS inviters_vouch,
       COALESCE(SUM(share_actions), 0) AS share_actions,
       COUNT(*) FILTER (WHERE share_actions > 0) AS bookers_with_share_actions,
       COUNT(*) FILTER (WHERE remaining_at_entry <= 0) AS final_spot_bookers,
       COUNT(*) FILTER (WHERE invited AND remaining_at_entry <= 0) AS final_spot_inviters,
       COUNT(*) FILTER (WHERE remaining_at_entry > 0) AS bookers_with_remaining_spots,
       COUNT(*) FILTER (WHERE remaining_at_entry IS NULL) AS bookers_without_availability_evidence,
       (SELECT host_only_inviters FROM host_only) AS host_only_inviters,
       $3::timestamptz >= $2::timestamptz + interval '24 hours' AS mature,
       GREATEST(0, EXTRACT(EPOCH FROM ($2::timestamptz + interval '24 hours' - $3::timestamptz))/3600) AS remaining_observation_hours,
       0.30 AS target
FROM per_entry;
