ALTER TABLE activities ADD COLUMN ends_at timestamptz;
UPDATE activities SET ends_at = starts_at + interval '2 hours';
ALTER TABLE activities ALTER COLUMN ends_at SET NOT NULL;
ALTER TABLE activities ADD CONSTRAINT activities_ends_after_start CHECK (ends_at > starts_at);

ALTER TABLE activities ADD COLUMN country_code text
  CHECK (country_code IN ('GB', 'IE', 'FR', 'DE', 'NL', 'ES', 'NG'));
UPDATE activities SET country_code = 'GB';
