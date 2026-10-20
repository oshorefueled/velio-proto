-- One viewer can span several sockets: a reconnecting client presents its
-- earlier server-issued connection id, and the new connection joins the same
-- viewer. An acknowledgement then closes measurements captured for any of
-- that viewer's connections, so a missed update recovered after reconnect is
-- recorded (with its full delay) instead of staying open forever. A viewer
-- that never returns still keeps its open measurement.
ALTER TABLE live_connections ADD COLUMN viewer_id uuid;
UPDATE live_connections SET viewer_id = connection_id;
ALTER TABLE live_connections ALTER COLUMN viewer_id SET NOT NULL;
CREATE INDEX live_connections_viewer_idx ON live_connections (viewer_id);
