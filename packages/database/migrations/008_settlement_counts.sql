ALTER TABLE settlements
  ADD COLUMN expected_tap_count BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN processed_tap_count BIGINT NOT NULL DEFAULT 0;
