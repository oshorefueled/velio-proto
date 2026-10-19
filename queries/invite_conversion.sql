-- $1/$2: seven-day half-open cohort; $3: as-of; $4: real|demo.
-- Resolve explicit identity first, otherwise the first immutable device link
-- visible at as-of. Deduplicate BEFORE cohort selection to prevent re-entry.
WITH opens AS (
  SELECT e.*, COALESCE(e.user_id::text, vi.user_id::text, 'visitor:' || e.visitor_id) AS person
  FROM events e
  LEFT JOIN visitor_identities vi ON vi.visitor_id::text = e.visitor_id
                                AND vi.created_at <= $3::timestamptz
  WHERE e.event_name = 'invite_opened' AND e.invite_id IS NOT NULL
    AND e.occurred_at <= $3::timestamptz
), first_opens AS (
  SELECT DISTINCT ON (person, invite_id) * FROM opens
  WHERE person IS NOT NULL ORDER BY person, invite_id, occurred_at, event_id
), opportunities AS (
  SELECT o.person, o.invite_id, o.occurred_at AS first_open_at,
         o.outcome, o.channel, i.rail, i.activity_id,
         LEAST(o.occurred_at + interval '24 hours', i.expires_at, a.starts_at) AS deadline
  FROM first_opens o
  JOIN invites i ON i.id = o.invite_id
  JOIN users creator ON creator.id = i.creator_id AND creator.dataset = $4
  JOIN activities a ON a.id = i.activity_id AND a.dataset = $4
  JOIN users host ON host.id = a.host_id AND host.dataset = $4
  JOIN activity_experiments x ON x.activity_id = a.id AND x.arm = 'treatment'
  LEFT JOIN users u ON u.id::text = o.person
  WHERE o.occurred_at >= $1::timestamptz AND o.occurred_at < $2::timestamptz
    AND (u.id IS NULL OR u.dataset = $4)
    AND a.created_at <= $3::timestamptz AND x.assigned_at <= $3::timestamptz
), annotated AS (
  SELECT o.*,
    EXISTS (SELECT 1 FROM bookings b
            JOIN booking_attributions ba ON ba.booking_id = b.id AND ba.invite_id = o.invite_id
            WHERE b.user_id::text = o.person AND b.activity_id = o.activity_id
              AND b.created_at >= o.first_open_at AND b.created_at < o.deadline
              AND b.created_at <= $3::timestamptz AND ba.claimed_at <= $3::timestamptz) AS converted,
    EXISTS (SELECT 1 FROM events cs
            LEFT JOIN visitor_identities vi ON vi.visitor_id::text = cs.visitor_id
                                          AND vi.created_at <= $3::timestamptz
            WHERE cs.event_name = 'claim_started' AND cs.invite_id = o.invite_id
              AND COALESCE(cs.user_id::text, vi.user_id::text, 'visitor:' || cs.visitor_id) = o.person
              AND cs.occurred_at >= o.first_open_at AND cs.occurred_at < o.deadline
              AND cs.occurred_at <= $3::timestamptz) AS claim_action,
    EXISTS (SELECT 1 FROM events ie WHERE ie.event_name = 'account_entry_completed'
            AND ie.user_id::text = o.person
            AND ie.occurred_at >= o.first_open_at AND ie.occurred_at < o.deadline
            AND ie.occurred_at <= $3::timestamptz) AS identity_completed,
    EXISTS (SELECT 1 FROM events err WHERE err.event_name = 'booking_attempted'
            AND err.user_id::text = o.person AND err.activity_id = o.activity_id
            AND err.details->>'source' IN ('invited','public_share','vouch')
            AND err.details->>'outcome' IN ('invite_not_found','invite_expired','invite_recipient_mismatch','lock_timeout','failed','commit_unknown','started')
            AND err.occurred_at >= o.first_open_at AND err.occurred_at < o.deadline
            AND err.occurred_at <= $3::timestamptz) AS claim_error
  FROM opportunities o
)
SELECT CASE WHEN GROUPING(rail) = 1 THEN 'total' ELSE 'by_rail_channel_landing' END AS segment,
       rail, channel, outcome AS landing_state,
       COUNT(*) AS opportunities, COUNT(*) FILTER (WHERE converted) AS converted_opportunities,
       COUNT(*) FILTER (WHERE converted)::numeric / NULLIF(COUNT(*), 0) AS conversion_rate,
       COUNT(*) FILTER (WHERE deadline <= first_open_at) AS closed_landings,
       COUNT(*) FILTER (WHERE claim_action AND NOT converted) AS identity_to_claim_dropoffs,
       COUNT(*) FILTER (WHERE claim_action) AS claim_started_opportunities,
       COUNT(*) FILTER (WHERE identity_completed) AS identity_completed_people_in_window,
       COUNT(*) FILTER (WHERE claim_error) AS activity_scoped_claim_error_opportunities,
       0.25 AS target,
       $3::timestamptz >= $2::timestamptz + interval '24 hours' AS mature,
       GREATEST(0, EXTRACT(EPOCH FROM ($2::timestamptz + interval '24 hours' - $3::timestamptz))/3600) AS remaining_observation_hours,
       $1::timestamptz AS cohort_start, $2::timestamptz AS cohort_end,
       $3::timestamptz AS as_of, $4 AS dataset
FROM annotated
GROUP BY GROUPING SETS ((rail, channel, outcome), ())
ORDER BY segment DESC;
