CREATE TABLE poll_ballots(poll_id TEXT NOT NULL REFERENCES polls(id),account_id TEXT NOT NULL REFERENCES accounts(id),mutation_id TEXT NOT NULL,PRIMARY KEY(poll_id,account_id));
ALTER TABLE push_subscriptions ADD COLUMN token_cipher TEXT;
ALTER TABLE collections ADD COLUMN language TEXT;
ALTER TABLE collections ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collections ADD COLUMN tag TEXT;
ALTER TABLE collections ADD COLUMN deleted_at TEXT;
