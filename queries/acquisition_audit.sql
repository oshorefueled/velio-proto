-- $1/$2: seven-day half-open cohort; $3: as-of; $4: real|demo.
-- Acquisition versus booking source (SPEC C1/C6, US-10): one row per account
-- acquired in the cohort or booking in it. Signup source, generation and
-- inviter are the immutable acquisition record; each booking keeps its own
-- source. A returning account booking through an invitation is not an
-- acquisition. Unlinked cross-device identity is not inferred.
WITH eligible_activities AS (
  -- The fixed existing-inviter cohort, defined exactly as k_factor_by_rail.
  SELECT a.* FROM activities a
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
), accounts AS (
  SELECT u.* FROM users u
  WHERE u.dataset = $4 AND u.created_at <= $3::timestamptz
    AND ((u.created_at >= $1::timestamptz AND u.created_at < $2::timestamptz)
      OR EXISTS (SELECT 1 FROM bookings b WHERE b.user_id = u.id
                 AND b.created_at >= $1::timestamptz AND b.created_at < $2::timestamptz
                 AND b.created_at <= $3::timestamptz))
)
SELECT u.id AS account_id, u.created_at AS account_created_at,
       u.signup_source, u.signup_generation, si.creator_id AS signup_inviter_id,
       si.code AS signup_invite_code,
       u.created_at >= $1::timestamptz AND u.created_at < $2::timestamptz AS acquired_in_cohort,
       -- Whether this account is an acquisition counted in k_factor_by_rail's
       -- numerator: newly acquired in the cohort through a treatment
       -- invitation from a fixed existing-cohort inviter.
       (u.created_at >= $1::timestamptz AND u.created_at < $2::timestamptz
        AND si.creator_id IN (SELECT id FROM cohort_inviters)
        AND si.created_at <= u.created_at
        AND EXISTS (SELECT 1 FROM activities sa
                    JOIN users sh ON sh.id = sa.host_id AND sh.dataset = $4
                    JOIN activity_experiments se ON se.activity_id = sa.id AND se.arm = 'treatment'
                    WHERE sa.id = si.activity_id AND sa.dataset = $4
                      AND sa.created_at <= u.created_at AND se.assigned_at <= u.created_at))
         IS TRUE AS in_k_factor_numerator,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
                  'booking_id', b.id, 'activity_id', b.activity_id, 'booked_at', b.created_at,
                  'source', COALESCE(ba.rail, 'direct'), 'generation', ba.generation,
                  'inviter_id', ba.inviter_id, 'invite_code', ba.code) ORDER BY b.created_at)
         FROM bookings b LEFT JOIN booking_attributions ba ON ba.booking_id = b.id
         WHERE b.user_id = u.id AND b.created_at >= $1::timestamptz AND b.created_at < $2::timestamptz
           AND b.created_at <= $3::timestamptz), '[]'::jsonb) AS booking_sources,
       $3::timestamptz >= $2::timestamptz AS mature,
       GREATEST(0, EXTRACT(EPOCH FROM ($2::timestamptz - $3::timestamptz)) / 3600) AS remaining_observation_hours
FROM accounts u
LEFT JOIN invites si ON si.id = u.signup_invite_id
ORDER BY u.created_at, u.id;
