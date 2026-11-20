CREATE TABLE agent_daily_stats (
  agent_id UUID NOT NULL REFERENCES agents(id),
  business_day DATE NOT NULL,
  cash_taken_minor BIGINT NOT NULL DEFAULT 0 CHECK (cash_taken_minor >= 0),
  topup_count INTEGER NOT NULL DEFAULT 0 CHECK (topup_count >= 0),
  commission_minor BIGINT NOT NULL DEFAULT 0 CHECK (commission_minor >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, business_day)
);

INSERT INTO agent_daily_stats(agent_id, business_day, cash_taken_minor, topup_count, commission_minor)
SELECT id, (now() AT TIME ZONE 'Africa/Blantyre')::date, 280000, 12, 48000
FROM agents
WHERE external_id = '+265999111222'
ON CONFLICT(agent_id, business_day) DO UPDATE
SET cash_taken_minor = EXCLUDED.cash_taken_minor,
    topup_count = EXCLUDED.topup_count,
    commission_minor = EXCLUDED.commission_minor,
    updated_at = now();
