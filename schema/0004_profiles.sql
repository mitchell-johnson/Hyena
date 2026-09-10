ALTER TABLE accounts ADD COLUMN avatar_media_id TEXT REFERENCES media_attachments(id);
ALTER TABLE accounts ADD COLUMN header_media_id TEXT REFERENCES media_attachments(id);
ALTER TABLE accounts ADD COLUMN totp_secret TEXT;
CREATE TABLE recovery_codes(account_id TEXT NOT NULL REFERENCES accounts(id),code_hash TEXT NOT NULL UNIQUE,used_at TEXT,PRIMARY KEY(account_id,code_hash));
CREATE TABLE passkeys(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),public_key TEXT NOT NULL,counter INTEGER NOT NULL DEFAULT 0,transports TEXT NOT NULL DEFAULT '[]',name TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE invites(code_hash TEXT PRIMARY KEY,expires_at INTEGER NOT NULL,max_uses INTEGER NOT NULL DEFAULT 1,uses INTEGER NOT NULL DEFAULT 0,created_by TEXT NOT NULL REFERENCES accounts(id));
