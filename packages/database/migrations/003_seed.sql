INSERT INTO roles(name) VALUES
  ('platform_admin'), ('platform_finance'), ('platform_support'),
  ('operator_admin'), ('operator_finance'), ('operator_fleet'), ('auditor')
ON CONFLICT (name) DO NOTHING;

WITH op AS (
  INSERT INTO operators(name) VALUES ('Lilongwe Campus Pilot') RETURNING id
),
route AS (
  INSERT INTO routes(operator_id, name, code)
  SELECT id, 'Campus Circle', 'CAMPUS-1' FROM op RETURNING id, operator_id
),
vehicle AS (
  INSERT INTO vehicles(operator_id, registration, route_id)
  SELECT operator_id, 'MW-001', id FROM route RETURNING id
),
customer AS (
  INSERT INTO customers(operator_id, external_ref, pseudonym)
  SELECT id, 'CUST-001', 'PSEUDO-001' FROM op RETURNING id, operator_id
),
card AS (
  INSERT INTO cards(operator_id, customer_id, card_token, status, tier, offline_allowance_minor)
  SELECT operator_id, id, 'BE-TEST-CARD-001', 'active', 'standard', 5000
  FROM customer RETURNING id, operator_id
),
terminal AS (
  INSERT INTO terminals(operator_id, name, status, key_reference)
  SELECT operator_id, 'Campus Reader 1', 'active', 'seed-key-1'
  FROM card RETURNING id, operator_id
),
agent AS (
  INSERT INTO agents(operator_id, name, commission_bps)
  SELECT operator_id, 'Campus Agent 1', 100
  FROM terminal RETURNING id, operator_id
)
INSERT INTO fare_rules(operator_id, route_id, fare_minor, valid_from)
SELECT r.operator_id, r.id, 500, '2026-01-01T00:00:00Z'
FROM route r;

WITH op AS (
  SELECT id AS operator_id FROM operators WHERE name = 'Lilongwe Campus Pilot'
),
customer AS (
  SELECT c.id AS customer_id, c.operator_id FROM customers c
  JOIN op o ON o.operator_id = c.operator_id
),
agent AS (
  SELECT a.id AS agent_id, a.operator_id FROM agents a
  JOIN op o ON o.operator_id = a.operator_id
)
INSERT INTO accounts(operator_id, code, name, account_type, customer_id)
SELECT operator_id, 'CUSTOMER_WALLET', 'Customer Wallet', 'customer_wallet', customer_id
FROM customer
UNION ALL
SELECT operator_id, 'OPERATOR_PAYABLE', 'Operator Payable', 'operator_payable', NULL
FROM op
UNION ALL
SELECT operator_id, 'PLATFORM_FEE', 'Platform Fee', 'platform_fee', NULL
FROM op
UNION ALL
SELECT operator_id, 'PLATFORM_CLEARING', 'Platform Clearing', 'system', NULL
FROM op
UNION ALL
SELECT operator_id, 'WRITE_OFF_EXPENSE', 'Write-Off Expense', 'expense', NULL
FROM op
UNION ALL
SELECT operator_id, 'COMMISSION_EXPENSE', 'Commission Expense', 'expense', NULL
FROM op
UNION ALL
SELECT operator_id, 'COMMISSION_PAYABLE', 'Commission Payable', 'liability', NULL
FROM op
UNION ALL
SELECT operator_id, 'AGENT_FLOAT', 'Agent Float', 'agent_float', NULL
FROM agent;

WITH pilot AS (
  SELECT id AS operator_id FROM operators WHERE name = 'Lilongwe Campus Pilot'
),
agent AS (
  SELECT a.id AS agent_id, a.operator_id
  FROM agents a JOIN pilot p ON p.operator_id = a.operator_id
)
UPDATE accounts ac
SET agent_id = agent.agent_id
FROM agent
WHERE ac.operator_id = agent.operator_id
  AND ac.code = 'AGENT_FLOAT';

WITH pilot AS (
  SELECT id AS operator_id FROM operators WHERE name = 'Lilongwe Campus Pilot'
),
agent AS (
  SELECT a.id AS agent_id, ac.id AS account_id, a.operator_id
  FROM agents a
  JOIN pilot p ON p.operator_id = a.operator_id
  JOIN accounts ac ON ac.operator_id = p.operator_id AND ac.code = 'AGENT_FLOAT'
)
UPDATE agents a
SET float_account_id = agent.account_id
FROM agent
WHERE a.id = agent.agent_id;
