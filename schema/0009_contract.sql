CREATE TABLE transaction_guards(id TEXT PRIMARY KEY,valid INTEGER NOT NULL CHECK(valid=1));
ALTER TABLE accounts ADD COLUMN created_by_application_id TEXT REFERENCES oauth_apps(id);
ALTER TABLE accounts ADD COLUMN signup_ip TEXT;
ALTER TABLE accounts ADD COLUMN signup_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE accounts ADD COLUMN moved_at TEXT;
CREATE INDEX jobs_order ON jobs(created_at,id);
CREATE INDEX activity_daily ON activity_metrics(account_id,kind,day);
