ALTER TABLE notifications ADD COLUMN details TEXT NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX local_account_email ON accounts(lower(email)) WHERE domain='' AND email IS NOT NULL;
