WITH op AS (
  SELECT id AS operator_id
  FROM operators
  WHERE name = 'Lilongwe Campus Pilot'
),
accounts AS (
  SELECT ac.id, ac.code, ac.operator_id
  FROM accounts ac
  JOIN op ON op.operator_id = ac.operator_id
  WHERE ac.code IN ('AGENT_FLOAT', 'PLATFORM_CLEARING')
),
header AS (
  INSERT INTO transactions(operator_id, idempotency_key, event_type, description)
  SELECT operator_id, 'seed:agent-float:initial', 'agent_buys_float', 'Seed pilot agent float'
  FROM op
  RETURNING id, operator_id
)
INSERT INTO ledger_entries(transaction_id, account_id, debit_minor, credit_minor)
SELECT h.id,
       (SELECT id FROM accounts ac
        WHERE ac.operator_id = h.operator_id AND ac.code = 'PLATFORM_CLEARING'),
       10000000,
       0
FROM header h
UNION ALL
SELECT h.id,
       (SELECT id FROM accounts ac
        WHERE ac.operator_id = h.operator_id AND ac.code = 'AGENT_FLOAT'),
       0,
       10000000
FROM header h;
