-- Hyena has its own database. Never apply this schema to an old Wildebeest DB.
CREATE TABLE sequences (name TEXT PRIMARY KEY, value INTEGER NOT NULL);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- This milestone deliberately provisions one owner; invitations come later.
  owner_slot INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (owner_slot = 1)
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  csrf TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE oauth_apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  website TEXT,
  client_id TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES oauth_apps(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  redirect_uri TEXT NOT NULL,
  scopes TEXT NOT NULL,
  challenge TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX oauth_codes_expiry ON oauth_codes(expires_at);
CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES oauth_apps(id),
  account_id TEXT REFERENCES accounts(id),
  scopes TEXT NOT NULL,
  code_hash TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX oauth_tokens_account ON oauth_tokens(account_id, revoked_at);

CREATE TABLE statuses (
  id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  text TEXT NOT NULL,
  content TEXT NOT NULL,
  spoiler_text TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'unlisted', 'private', 'direct')),
  sensitive INTEGER NOT NULL DEFAULT 0 CHECK (sensitive IN (0,1)),
  language TEXT,
  in_reply_to_id TEXT REFERENCES statuses(id),
  created_at TEXT NOT NULL,
  edited_at TEXT,
  deleted_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  mutation_id TEXT NOT NULL,
  request_key TEXT,
  request_hash TEXT,
  UNIQUE(account_id, request_key)
);
CREATE INDEX statuses_author ON statuses(account_id, sequence DESC) WHERE deleted_at IS NULL;
CREATE INDEX statuses_public ON statuses(visibility, sequence DESC) WHERE deleted_at IS NULL;
CREATE INDEX statuses_replies ON statuses(in_reply_to_id, sequence) WHERE deleted_at IS NULL;
CREATE TABLE status_revisions (
  status_id TEXT NOT NULL REFERENCES statuses(id),
  revision INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(status_id, revision)
);

CREATE TABLE media_attachments (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  status_id TEXT REFERENCES statuses(id),
  position INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK(state IN ('uploading', 'uploaded', 'processing', 'ready', 'failed')),
  original_key TEXT NOT NULL,
  output_key TEXT,
  preview_key TEXT,
  mime_type TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK(media_type IN ('image', 'video', 'audio')),
  bytes INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  focus_x REAL NOT NULL DEFAULT 0,
  focus_y REAL NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX media_status ON media_attachments(status_id, position);
CREATE INDEX media_orphans ON media_attachments(updated_at) WHERE status_id IS NULL;

-- This is both the transactional outbox and the durable job ledger. Queues
-- only carries {version,id}; a queue expiry can never erase the durable intent.
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('status.event', 'media.process')),
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending', 'queued', 'processing', 'done', 'dead')),
  attempt INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  dispatch_until INTEGER,
  queued_at INTEGER,
  lease_token TEXT,
  lease_until INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX jobs_due ON jobs(available_at) WHERE state IN ('pending','queued','processing');
CREATE INDEX jobs_completed ON jobs(completed_at) WHERE state = 'done';
