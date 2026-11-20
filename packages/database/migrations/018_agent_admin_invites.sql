ALTER TABLE agents ADD COLUMN IF NOT EXISTS invitation_token_hash TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS invitation_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS agents_invitation_token_hash_idx
  ON agents(invitation_token_hash)
  WHERE invitation_token_hash IS NOT NULL;
