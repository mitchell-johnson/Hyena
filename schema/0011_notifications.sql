ALTER TABLE polls ADD COLUMN notified_at TEXT;
ALTER TABLE notifications ADD COLUMN collection_id TEXT REFERENCES collections(id);
CREATE INDEX notifications_collection ON notifications(collection_id);
