ALTER TABLE accounts ADD COLUMN totp_last_counter INTEGER NOT NULL DEFAULT -1;
ALTER TABLE oauth_tokens ADD COLUMN expires_at INTEGER;
ALTER TABLE email_tokens ADD COLUMN email TEXT;
CREATE TABLE account_exports(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),object_key TEXT,status TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL);
CREATE TABLE job_locks(key TEXT PRIMARY KEY,job_id TEXT NOT NULL,lease_token TEXT NOT NULL,lease_until INTEGER NOT NULL);
CREATE INDEX job_locks_expiry ON job_locks(lease_until);
CREATE INDEX jobs_ordering ON jobs(json_extract(payload,'$.orderingKey'),created_at) WHERE kind='federation.message';
CREATE TABLE import_tasks(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),kind TEXT NOT NULL,mode TEXT NOT NULL,data TEXT NOT NULL,offset INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'pending',errors TEXT NOT NULL DEFAULT '[]',created_at TEXT NOT NULL);
