INSERT INTO taps(operator_id, tap_id, card_id, terminal_id, route_id, tapped_at, counter,
  claimed_fare_minor, settled_fare_minor, offline_flag, signature, status, posted_transaction_id, created_at)
SELECT t.operator_id,
       md5(t.idempotency_key || ':tap')::uuid,
       c.id,
       tm.id,
       r.id,
       TIMESTAMPTZ '2026-11-20 14:26:00+02' - ((3 - substring(t.idempotency_key FROM '([0-9]+)$')::int) * interval '3 minutes'),
       120 + substring(t.idempotency_key FROM '([0-9]+)$')::int,
       50000,
       50000,
       false,
       'seed',
       'posted',
       t.id,
       TIMESTAMPTZ '2026-11-20 14:26:00+02' - ((3 - substring(t.idempotency_key FROM '([0-9]+)$')::int) * interval '3 minutes')
FROM transactions t
JOIN cards c ON c.card_token = 'CARD-1001'
JOIN terminals tm ON tm.operator_id = t.operator_id
JOIN routes r ON r.operator_id = t.operator_id
WHERE t.idempotency_key LIKE 'seed:mobile:trip:%'
ON CONFLICT(tap_id) DO NOTHING;
