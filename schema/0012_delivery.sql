ALTER TABLE jobs ADD COLUMN first_attempt_at INTEGER;
ALTER TABLE statuses ADD COLUMN federation_started INTEGER NOT NULL DEFAULT 0;
CREATE INDEX media_output_key ON media_attachments(output_key);
CREATE INDEX media_preview_key ON media_attachments(preview_key);
CREATE INDEX jobs_order_all ON jobs(json_extract(payload,'$.orderingKey'));
