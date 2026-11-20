ALTER TABLE customers ADD COLUMN IF NOT EXISTS full_name TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS gender TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS location TEXT;

CREATE TABLE customer_registration_challenges (
  phone TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  gender TEXT,
  email TEXT,
  location TEXT,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  resend_allowed_at TIMESTAMPTZ NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX customer_registration_challenges_expiry_idx
  ON customer_registration_challenges(expires_at);

CREATE TABLE customer_registration_rate_limits (
  phone_hash TEXT PRIMARY KEY,
  window_started_at TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  resend_allowed_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX customer_registration_rate_limits_expiry_idx
  ON customer_registration_rate_limits(window_started_at);

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_operator_id_code_key;
CREATE UNIQUE INDEX accounts_operator_code_non_customer_wallet_unique
  ON accounts(operator_id, code)
  WHERE code <> 'CUSTOMER_WALLET';
CREATE UNIQUE INDEX accounts_customer_wallet_unique
  ON accounts(operator_id, customer_id)
  WHERE code = 'CUSTOMER_WALLET' AND customer_id IS NOT NULL;
