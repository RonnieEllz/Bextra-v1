CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE operators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE routes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id UUID NOT NULL REFERENCES operators(id),
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  UNIQUE(operator_id, code)
);

CREATE TABLE vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id UUID NOT NULL REFERENCES operators(id),
  registration TEXT NOT NULL,
  route_id UUID NOT NULL REFERENCES routes(id),
  UNIQUE(operator_id, registration)
);

CREATE TABLE fare_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id UUID NOT NULL REFERENCES operators(id),
  route_id UUID NOT NULL REFERENCES routes(id),
  fare_minor BIGINT NOT NULL CHECK (fare_minor >= 0),
  valid_from TIMESTAMPTZ NOT NULL,
  valid_to TIMESTAMPTZ,
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE INDEX fare_rules_lookup_idx ON fare_rules(operator_id, route_id, valid_from, valid_to);

CREATE TABLE terminals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id UUID NOT NULL REFERENCES operators(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  public_key TEXT,
  key_reference TEXT,
  last_heartbeat_at TIMESTAMPTZ,
  offline_queue_count INTEGER NOT NULL DEFAULT 0,
  blocked_list_version BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id UUID NOT NULL REFERENCES operators(id),
  external_ref TEXT,
  pseudonym TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id UUID NOT NULL REFERENCES operators(id),
  customer_id UUID REFERENCES customers(id),
  card_token TEXT NOT NULL UNIQUE,
  desfire_key_reference TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  tier TEXT NOT NULL DEFAULT 'standard',
  offline_allowance_minor BIGINT NOT NULL DEFAULT 0,
  counter BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id UUID NOT NULL REFERENCES operators(id),
  name TEXT NOT NULL,
  float_account_id UUID,
  commission_bps INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id UUID REFERENCES operators(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'MWK',
  customer_id UUID REFERENCES customers(id),
  agent_id UUID REFERENCES agents(id),
  UNIQUE(operator_id, code)
);

CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id UUID REFERENCES operators(id),
  idempotency_key TEXT,
  event_type TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX transactions_idempotency_unique ON transactions(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES transactions(id),
  account_id UUID NOT NULL REFERENCES accounts(id),
  debit_minor BIGINT NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),
  credit_minor BIGINT NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((debit_minor = 0) <> (credit_minor = 0))
);
CREATE INDEX ledger_entries_account_idx ON ledger_entries(account_id);

CREATE TABLE batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id UUID NOT NULL REFERENCES operators(id),
  terminal_id UUID NOT NULL REFERENCES terminals(id),
  batch_id UUID NOT NULL UNIQUE,
  declared_count INTEGER NOT NULL,
  processed_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'received',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE taps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id UUID NOT NULL REFERENCES operators(id),
  tap_id UUID NOT NULL UNIQUE,
  batch_id UUID REFERENCES batches(id),
  card_id UUID REFERENCES cards(id),
  terminal_id UUID NOT NULL REFERENCES terminals(id),
  route_id UUID REFERENCES routes(id),
  tapped_at TIMESTAMPTZ NOT NULL,
  counter BIGINT NOT NULL,
  claimed_fare_minor BIGINT NOT NULL,
  settled_fare_minor BIGINT,
  offline_flag BOOLEAN NOT NULL,
  signature TEXT NOT NULL,
  status TEXT NOT NULL,
  reject_reason TEXT,
  posted_transaction_id UUID REFERENCES transactions(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX taps_terminal_counter_unique ON taps(terminal_id, counter);

CREATE TABLE blacklist_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id UUID NOT NULL REFERENCES operators(id),
  card_id UUID NOT NULL REFERENCES cards(id),
  version BIGINT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(operator_id, card_id, version)
);

CREATE TABLE risk_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id UUID NOT NULL REFERENCES operators(id),
  tap_id UUID REFERENCES taps(id),
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id UUID NOT NULL REFERENCES operators(id),
  tap_id UUID REFERENCES taps(id),
  status TEXT NOT NULL DEFAULT 'open',
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id UUID NOT NULL REFERENCES operators(id),
  business_day DATE NOT NULL,
  expected_minor BIGINT NOT NULL DEFAULT 0,
  posted_minor BIGINT NOT NULL DEFAULT 0,
  difference_minor BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  override_reason TEXT,
  override_actor_id UUID,
  override_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(operator_id, business_day)
);

CREATE TABLE funding_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id UUID NOT NULL REFERENCES operators(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  agent_id UUID REFERENCES agents(id),
  card_id UUID REFERENCES cards(id),
  amount_minor BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE provider_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id UUID REFERENCES operators(id),
  provider_transaction_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id UUID REFERENCES operators(id),
  role_id UUID NOT NULL REFERENCES roles(id),
  external_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID REFERENCES users(id),
  actor_role TEXT,
  operator_id UUID REFERENCES operators(id),
  action TEXT NOT NULL,
  reason TEXT,
  request_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
