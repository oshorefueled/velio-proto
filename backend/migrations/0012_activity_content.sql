ALTER TABLE activities ADD COLUMN description text NOT NULL DEFAULT 'Activity details coming soon.' CHECK (length(btrim(description)) > 0);
ALTER TABLE plans ADD COLUMN itinerary text NOT NULL DEFAULT 'Meet your host at the scheduled start.' CHECK (length(btrim(itinerary)) > 0);
ALTER TABLE users ADD COLUMN summary text NOT NULL DEFAULT '';
CREATE UNIQUE INDEX users_email_normalized ON users (lower(btrim(contact_key)));
