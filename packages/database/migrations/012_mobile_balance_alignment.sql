WITH pilot AS (
  SELECT id FROM operators WHERE name = 'Lilongwe Campus Pilot' LIMIT 1
),
customer AS (
  SELECT id, operator_id FROM customers WHERE phone = '+265888100200' LIMIT 1
),
wallet AS (
  SELECT ac.id, ac.operator_id FROM accounts ac JOIN customer c ON c.id = ac.customer_id
  WHERE ac.code = 'CUSTOMER_WALLET'
),
clearing AS (
  SELECT ac.id FROM accounts ac JOIN pilot p ON p.id = ac.operator_id
  WHERE ac.code = 'PLATFORM_CLEARING'
),
balance AS (
  SELECT COALESCE(SUM(le.credit_minor - le.debit_minor), 0)::bigint AS amount
  FROM ledger_entries le JOIN wallet w ON w.id = le.account_id
),
delta AS (
  SELECT (1245000 - amount)::bigint AS amount FROM balance
),
header AS (
  INSERT INTO transactions(operator_id, idempotency_key, event_type, description)
  SELECT w.operator_id, 'seed:mobile:balance-alignment', 'seed_balance_alignment', 'Align demo customer balance'
  FROM wallet w CROSS JOIN delta d
  WHERE d.amount <> 0
  ON CONFLICT DO NOTHING
  RETURNING id
)
INSERT INTO ledger_entries(transaction_id, account_id, debit_minor, credit_minor)
SELECT h.id, w.id,
       CASE WHEN d.amount < 0 THEN -d.amount ELSE 0 END,
       CASE WHEN d.amount > 0 THEN d.amount ELSE 0 END
FROM header h CROSS JOIN wallet w CROSS JOIN delta d
UNION ALL
SELECT h.id, c.id,
       CASE WHEN d.amount > 0 THEN d.amount ELSE 0 END,
       CASE WHEN d.amount < 0 THEN -d.amount ELSE 0 END
FROM header h CROSS JOIN clearing c CROSS JOIN delta d;
