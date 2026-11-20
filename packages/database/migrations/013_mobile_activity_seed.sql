UPDATE funding_requests
SET id = md5('seed:mobile:pending')::uuid,
    card_id = (SELECT id FROM cards WHERE card_token = 'CARD-1001'),
    created_at = TIMESTAMPTZ '2026-11-20 14:35:00+02'
WHERE idempotency_key = 'seed:mobile:pending';

UPDATE funding_requests
SET created_at = TIMESTAMPTZ '2026-11-20 14:32:00+02',
    confirmed_at = TIMESTAMPTZ '2026-11-20 14:32:00+02',
    response = response || jsonb_build_object('confirmedAt', TIMESTAMPTZ '2026-11-20 14:32:00+02')
WHERE idempotency_key = 'seed:mobile:confirmed';

WITH pilot AS (
  SELECT id FROM operators WHERE name = 'Lilongwe Campus Pilot' LIMIT 1
),
card AS (
  SELECT id FROM cards WHERE card_token = 'CARD-1001'
),
terminal AS (
  SELECT id, operator_id FROM terminals
  WHERE operator_id = (SELECT id FROM pilot)
  ORDER BY id LIMIT 1
),
route AS (
  SELECT id, operator_id FROM routes
  WHERE operator_id = (SELECT id FROM pilot)
  ORDER BY id LIMIT 1
),
trips AS (
  SELECT t.id, t.operator_id, substring(t.idempotency_key FROM '([0-9]+)$')::int AS sequence
  FROM transactions t
  WHERE t.idempotency_key LIKE 'seed:mobile:trip:%'
)
INSERT INTO taps(operator_id, tap_id, card_id, terminal_id, route_id, tapped_at, counter,
  claimed_fare_minor, settled_fare_minor, offline_flag, signature, status, posted_transaction_id, created_at)
SELECT trip.operator_id,
       md5('seed:mobile:trip:' || trip.sequence || ':tap')::uuid,
       card.id,
       terminal.id,
       route.id,
       TIMESTAMPTZ '2026-11-20 14:26:00+02' - ((3 - trip.sequence) * interval '3 minutes'),
       120 + trip.sequence,
       50000,
       50000,
       false,
       'seed',
       'posted',
       trip.id,
       TIMESTAMPTZ '2026-11-20 14:26:00+02' - ((3 - trip.sequence) * interval '3 minutes')
FROM trips trip
JOIN card ON true
JOIN terminal ON terminal.operator_id = trip.operator_id
JOIN route ON route.operator_id = trip.operator_id
ON CONFLICT(tap_id) DO NOTHING;

UPDATE cards SET counter = 123, last_synced_at = TIMESTAMPTZ '2026-11-20 14:32:00+02'
WHERE card_token = 'CARD-1001';
