DELETE FROM taps tap
USING transactions tx
WHERE tx.id = tap.posted_transaction_id
  AND tx.idempotency_key LIKE 'seed:mobile:trip:%'
  AND tap.tap_id = md5(tx.id::text || ':tap')::uuid
  AND tap.signature = 'seed'
  AND tap.card_id = (SELECT id FROM cards WHERE card_token = 'CARD-1001');
