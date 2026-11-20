INSERT INTO roles(name)
VALUES ('agent')
ON CONFLICT(name) DO NOTHING;

WITH pilot AS (
  SELECT id AS operator_id
  FROM operators
  WHERE name = 'Lilongwe Campus Pilot'
),
agent_role AS (
  SELECT id AS role_id
  FROM roles
  WHERE name = 'agent'
)
INSERT INTO users(operator_id, role_id, external_id, password_hash, status)
SELECT
  (SELECT operator_id FROM pilot),
  (SELECT role_id FROM agent_role),
  'pilot-agent',
  '$2b$12$Cy2xs7qwgqxHLdPV6m7enukzb2LeudYXW3sNYY6k6EYjPvD3jmro.',
  'active'
WHERE EXISTS (SELECT 1 FROM pilot)
ON CONFLICT(external_id) DO UPDATE
SET password_hash = EXCLUDED.password_hash,
    status = EXCLUDED.status;
