WITH op AS (
  SELECT id AS operator_id
  FROM operators
  WHERE name = 'Lilongwe Campus Pilot'
),
header AS (
  INSERT INTO transactions(operator_id, idempotency_key, event_type, description)
  SELECT operator_id,
         'seed:agent-float:initial',
         'agent_buys_float',
         'Seed pilot agent float'
  FROM op
  ON CONFLICT DO NOTHING
  RETURNING id, operator_id
)
INSERT INTO ledger_entries(transaction_id, account_id, debit_minor, credit_minor)
SELECT h.id,
       ac.id,
       CASE WHEN ac.code = 'PLATFORM_CLEARING' THEN 10000000 ELSE 0 END,
       CASE WHEN ac.code = 'AGENT_FLOAT' THEN 10000000 ELSE 0 END
FROM header h
JOIN accounts ac ON ac.operator_id = h.operator_id
WHERE ac.code IN ('PLATFORM_CLEARING', 'AGENT_FLOAT')
  AND NOT EXISTS (
    SELECT 1
    FROM ledger_entries existing
    WHERE existing.transaction_id = h.id
  );
