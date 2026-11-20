ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS customers_phone_unique ON customers(phone) WHERE phone IS NOT NULL;

ALTER TABLE agents ADD COLUMN IF NOT EXISTS external_id TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS pin_hash TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS location TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS opening_float_minor BIGINT NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS agents_external_id_unique ON agents(external_id) WHERE external_id IS NOT NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(id);
ALTER TABLE cards ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;

ALTER TABLE funding_requests ADD COLUMN IF NOT EXISTS transaction_id UUID REFERENCES transactions(id);
ALTER TABLE funding_requests ADD COLUMN IF NOT EXISTS commission_minor BIGINT NOT NULL DEFAULT 0;
ALTER TABLE funding_requests ADD COLUMN IF NOT EXISTS request_hash TEXT;
ALTER TABLE funding_requests ADD COLUMN IF NOT EXISTS response JSONB;
ALTER TABLE funding_requests ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS otp_challenges (
  phone TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  resend_allowed_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO roles(name) VALUES ('customer') ON CONFLICT(name) DO NOTHING;

WITH pilot AS (
  SELECT id FROM operators WHERE name = 'Lilongwe Campus Pilot' LIMIT 1
),
customer AS (
  SELECT c.id, c.operator_id
  FROM customers c JOIN pilot p ON p.id = c.operator_id
  ORDER BY c.created_at LIMIT 1
)
UPDATE customers c
SET phone = '+265888100200'
FROM customer
WHERE c.id = customer.id;

WITH pilot AS (
  SELECT id FROM operators WHERE name = 'Lilongwe Campus Pilot' LIMIT 1
),
agent AS (
  SELECT id, operator_id
  FROM agents
  WHERE operator_id = (SELECT id FROM pilot)
  ORDER BY id LIMIT 1
)
UPDATE agents
SET name = 'Maureen''s Kiosk',
    external_id = '+265999111222',
    pin_hash = '$2b$10$.gBAuh7A26L/mTnI9ntDV.kpSht4z.JVnQYnWFIITyMS9vAnkencW',
    location = 'Area 18 · Near Shoprite',
    opening_float_minor = 5000000
WHERE id = (SELECT id FROM agent);

WITH pilot AS (
  SELECT id FROM operators WHERE name = 'Lilongwe Campus Pilot' LIMIT 1
),
customer AS (
  SELECT id, operator_id FROM customers
  WHERE operator_id = (SELECT id FROM pilot) AND phone = '+265888100200'
  LIMIT 1
)
INSERT INTO cards(operator_id, customer_id, card_token, status, tier, offline_allowance_minor, last_synced_at)
SELECT operator_id, id, 'CARD-1001', 'active', 'standard', 300000, now()
FROM customer
ON CONFLICT(card_token) DO UPDATE
SET customer_id = EXCLUDED.customer_id,
    status = 'active',
    tier = 'standard',
    offline_allowance_minor = 300000,
    last_synced_at = now();

WITH pilot AS (
  SELECT id FROM operators WHERE name = 'Lilongwe Campus Pilot' LIMIT 1
),
customer AS (
  SELECT id, operator_id FROM customers
  WHERE operator_id = (SELECT id FROM pilot) AND phone = '+265888100200'
  LIMIT 1
)
INSERT INTO cards(operator_id, customer_id, card_token, status, tier, offline_allowance_minor, last_synced_at)
SELECT operator_id, id, 'CARD-1002', 'active', 'standard', 300000, now()
FROM customer
ON CONFLICT(card_token) DO UPDATE
SET customer_id = EXCLUDED.customer_id,
    status = 'active',
    tier = 'standard',
    offline_allowance_minor = 300000,
    last_synced_at = now();

WITH pilot AS (
  SELECT id FROM operators WHERE name = 'Lilongwe Campus Pilot' LIMIT 1
),
customer AS (
  SELECT id, operator_id FROM customers
  WHERE operator_id = (SELECT id FROM pilot) AND phone = '+265888100200'
  LIMIT 1
),
agent AS (
  SELECT id, operator_id FROM agents
  WHERE operator_id = (SELECT id FROM pilot) AND external_id = '+265999111222'
  LIMIT 1
),
customer_role AS (SELECT id FROM roles WHERE name = 'customer'),
agent_role AS (SELECT id FROM roles WHERE name = 'agent')
INSERT INTO users(operator_id, role_id, external_id, password_hash, status, customer_id)
SELECT operator_id, (SELECT id FROM customer_role), '+265888100200',
       '$2b$12$Cy2xs7qwgqxHLdPV6m7enukzb2LeudYXW3sNYY6k6EYjPvD3jmro.', 'active', id
FROM customer
ON CONFLICT(external_id) DO UPDATE
SET operator_id = EXCLUDED.operator_id,
    role_id = EXCLUDED.role_id,
    customer_id = EXCLUDED.customer_id,
    status = 'active';

WITH pilot AS (
  SELECT id FROM operators WHERE name = 'Lilongwe Campus Pilot' LIMIT 1
),
agent AS (
  SELECT id, operator_id FROM agents
  WHERE operator_id = (SELECT id FROM pilot) AND external_id = '+265999111222'
  LIMIT 1
)
INSERT INTO users(operator_id, role_id, external_id, password_hash, status, agent_id)
SELECT operator_id, (SELECT id FROM roles WHERE name = 'agent'), '+265999111222',
       '$2b$12$Cy2xs7qwgqxHLdPV6m7enukzb2LeudYXW3sNYY6k6EYjPvD3jmro.', 'active', id
FROM agent
ON CONFLICT(external_id) DO UPDATE
SET operator_id = EXCLUDED.operator_id,
    role_id = EXCLUDED.role_id,
    agent_id = EXCLUDED.agent_id,
    status = 'active';

UPDATE users u
SET agent_id = a.id
FROM agents a
WHERE u.external_id = 'pilot-agent'
  AND a.external_id = '+265999111222'
  AND u.agent_id IS NULL;

WITH agent AS (
  SELECT a.id, a.operator_id, a.float_account_id
  FROM agents a
  WHERE a.external_id = '+265999111222'
  LIMIT 1
),
balance AS (
  SELECT COALESCE(SUM(le.credit_minor - le.debit_minor), 0)::bigint AS amount
  FROM ledger_entries le JOIN agent a ON le.account_id = a.float_account_id
),
clearing AS (
  SELECT ac.id FROM accounts ac JOIN agent a ON a.operator_id = ac.operator_id
  WHERE ac.code = 'PLATFORM_CLEARING'
),
header AS (
  INSERT INTO transactions(operator_id, idempotency_key, event_type, description)
  SELECT a.operator_id, 'seed:mobile:float-opening', 'seed_agent_float', 'Set mobile demo opening float'
  FROM agent a, balance b
  WHERE b.amount <> 5000000
  ON CONFLICT DO NOTHING
  RETURNING id
),
delta AS (
  SELECT (5000000 - b.amount)::bigint AS amount FROM balance b
)
INSERT INTO ledger_entries(transaction_id, account_id, debit_minor, credit_minor)
SELECT h.id,
       a.float_account_id,
       CASE WHEN d.amount < 0 THEN -d.amount ELSE 0 END,
       CASE WHEN d.amount > 0 THEN d.amount ELSE 0 END
FROM header h CROSS JOIN delta d CROSS JOIN agent a CROSS JOIN clearing c
UNION ALL
SELECT h.id,
       c.id,
       CASE WHEN d.amount > 0 THEN d.amount ELSE 0 END,
       CASE WHEN d.amount < 0 THEN -d.amount ELSE 0 END
FROM header h CROSS JOIN delta d CROSS JOIN agent a CROSS JOIN clearing c;

WITH operator AS (
  SELECT id FROM operators WHERE name = 'Lilongwe Campus Pilot' LIMIT 1
),
customer AS (
  SELECT id, operator_id FROM customers WHERE phone = '+265888100200' LIMIT 1
),
wallet AS (
  SELECT ac.id, ac.operator_id FROM accounts ac
  JOIN customer c ON c.id = ac.customer_id
  WHERE ac.code = 'CUSTOMER_WALLET'
),
clearing AS (
  SELECT ac.id FROM accounts ac JOIN operator o ON ac.operator_id = o.id
  WHERE ac.code = 'PLATFORM_CLEARING'
),
header AS (
  INSERT INTO transactions(operator_id, idempotency_key, event_type, description)
  SELECT id, 'seed:mobile:customer-opening', 'seed_customer_balance', 'Mobile demo customer opening balance'
  FROM operator
  ON CONFLICT DO NOTHING
  RETURNING id
)
INSERT INTO ledger_entries(transaction_id, account_id, debit_minor, credit_minor)
SELECT h.id, c.id, 0, 1195000 FROM header h CROSS JOIN wallet c
UNION ALL
SELECT h.id, c.id, 1195000, 0 FROM header h CROSS JOIN clearing c;

WITH operator AS (
  SELECT id FROM operators WHERE name = 'Lilongwe Campus Pilot' LIMIT 1
),
agent AS (
  SELECT id, operator_id, float_account_id, commission_bps FROM agents
  WHERE external_id = '+265999111222' LIMIT 1
),
customer AS (
  SELECT id, operator_id FROM customers WHERE phone = '+265888100200' LIMIT 1
),
card AS (
  SELECT id FROM cards WHERE card_token = 'CARD-1001'
),
wallet AS (
  SELECT ac.id FROM accounts ac JOIN customer c ON c.id = ac.customer_id
  WHERE ac.code = 'CUSTOMER_WALLET'
),
clearing AS (
  SELECT ac.id FROM accounts ac JOIN operator o ON ac.operator_id = o.id
  WHERE ac.code = 'PLATFORM_CLEARING'
),
header AS (
  INSERT INTO transactions(operator_id, idempotency_key, event_type, description)
  SELECT a.operator_id, 'topup:seed:mobile:confirmed', 'agent_topup', 'Seed mobile demo top-up'
  FROM agent a
  ON CONFLICT DO NOTHING
  RETURNING id, operator_id
),
entries AS (
  INSERT INTO ledger_entries(transaction_id, account_id, debit_minor, credit_minor)
  SELECT h.id, a.float_account_id, 200000, 0 FROM header h CROSS JOIN agent a
  UNION ALL
  SELECT h.id, w.id, 0, 200000 FROM header h CROSS JOIN wallet w
  UNION ALL
  SELECT h.id, ac.id, 2000, 0
  FROM header h JOIN accounts ac ON ac.operator_id = h.operator_id AND ac.code = 'COMMISSION_EXPENSE'
  UNION ALL
  SELECT h.id, ac.id, 0, 2000
  FROM header h JOIN accounts ac ON ac.operator_id = h.operator_id AND ac.code = 'COMMISSION_PAYABLE'
  RETURNING transaction_id
)
INSERT INTO funding_requests(id, operator_id, idempotency_key, agent_id, card_id, amount_minor,
  status, transaction_id, commission_minor, request_hash, response, confirmed_at)
SELECT md5('seed:mobile:confirmed')::uuid, a.operator_id, 'seed:mobile:confirmed', a.id, c.id, 200000, 'confirmed',
       h.id, 2000, 'seed:mobile:confirmed',
       jsonb_build_object('status', 'confirmed', 'fundingRequestId', md5('seed:mobile:confirmed')::uuid,
         'transactionId', h.id, 'cardToken', 'CARD-1001', 'amountMinor', 200000,
         'commissionMinor', 2000, 'remainingAgentFloatMinor', 4800000,
         'confirmedAt', now()),
       now()
FROM header h CROSS JOIN agent a CROSS JOIN card c
WHERE EXISTS (SELECT 1 FROM entries);

INSERT INTO funding_requests(operator_id, idempotency_key, agent_id, card_id, amount_minor, status)
SELECT a.operator_id, 'seed:mobile:pending', a.id, c.id, 50000, 'pending'
FROM agents a CROSS JOIN cards c
WHERE a.external_id = '+265999111222' AND c.card_token = 'CARD-1002'
ON CONFLICT(idempotency_key) DO NOTHING;

WITH operator AS (
  SELECT id FROM operators WHERE name = 'Lilongwe Campus Pilot' LIMIT 1
),
customer AS (
  SELECT id FROM customers WHERE phone = '+265888100200' LIMIT 1
),
wallet AS (
  SELECT ac.id FROM accounts ac JOIN customer c ON c.id = ac.customer_id
  WHERE ac.code = 'CUSTOMER_WALLET'
),
payable AS (
  SELECT ac.id FROM accounts ac JOIN operator o ON ac.operator_id = o.id
  WHERE ac.code = 'OPERATOR_PAYABLE'
),
trips AS (
  INSERT INTO transactions(operator_id, idempotency_key, event_type, description, created_at)
  SELECT id, 'seed:mobile:trip:' || n, 'fare', 'Campus Circle trip',
         now() - (4 - n) * interval '1 hour'
  FROM operator CROSS JOIN generate_series(1, 3) AS n
  ON CONFLICT DO NOTHING
  RETURNING id, idempotency_key, created_at
),
entries AS (
  INSERT INTO ledger_entries(transaction_id, account_id, debit_minor, credit_minor)
  SELECT t.id, w.id, 50000, 0 FROM trips t CROSS JOIN wallet w
  UNION ALL
  SELECT t.id, p.id, 0, 50000 FROM trips t CROSS JOIN payable p
  RETURNING transaction_id
)
INSERT INTO taps(operator_id, tap_id, card_id, terminal_id, route_id, tapped_at, counter,
  claimed_fare_minor, settled_fare_minor, offline_flag, signature, status, posted_transaction_id, created_at)
SELECT o.id, md5(t.id::text || ':tap')::uuid, c.id, tm.id, r.id, t.created_at, 120 + row_number() OVER (ORDER BY t.created_at),
       50000, 50000, false, 'seed', 'posted', t.id, t.created_at
FROM trips t CROSS JOIN operator o
CROSS JOIN customer cu
JOIN cards c ON c.card_token = 'CARD-1001'
JOIN terminals tm ON tm.operator_id = o.id
JOIN routes r ON r.operator_id = o.id
WHERE EXISTS (SELECT 1 FROM entries)
ON CONFLICT(tap_id) DO NOTHING;

UPDATE cards SET counter = 123, last_synced_at = now()
WHERE card_token = 'CARD-1001';
