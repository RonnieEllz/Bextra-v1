ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;

WITH pilot AS (
  SELECT id AS operator_id
  FROM operators
  WHERE name = 'Lilongwe Campus Pilot'
),
platform_role AS (
  SELECT id AS role_id
  FROM roles
  WHERE name = 'platform_admin'
),
operator_role AS (
  SELECT id AS role_id
  FROM roles
  WHERE name = 'operator_finance'
)
INSERT INTO users(operator_id, role_id, external_id, password_hash, status)
VALUES
  (NULL,
   (SELECT role_id FROM platform_role),
   'platform-admin',
   '$2b$12$Cy2xs7qwgqxHLdPV6m7enukzb2LeudYXW3sNYY6k6EYjPvD3jmro.',
   'active'),
  ((SELECT operator_id FROM pilot),
   (SELECT role_id FROM operator_role),
   'operator-finance',
   '$2b$12$Cy2xs7qwgqxHLdPV6m7enukzb2LeudYXW3sNYY6k6EYjPvD3jmro.',
   'active')
ON CONFLICT (external_id) DO UPDATE
SET password_hash = EXCLUDED.password_hash,
    status = EXCLUDED.status;
