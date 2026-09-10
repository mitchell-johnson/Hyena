CREATE TABLE relationship_events (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id),
 type TEXT NOT NULL CHECK(type IN ('domain_block','user_domain_block','account_suspension')),
 target_name TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX relationship_events_account ON relationship_events(account_id,id);
CREATE TABLE severed_relationships (
 event_id TEXT NOT NULL REFERENCES relationship_events(id) ON DELETE CASCADE,
 follow_id TEXT NOT NULL, target_id TEXT NOT NULL, address TEXT NOT NULL,
 direction TEXT NOT NULL CHECK(direction IN ('following','followers')),
 reblogs INTEGER NOT NULL, notify INTEGER NOT NULL, languages TEXT NOT NULL,
 PRIMARY KEY(event_id,follow_id)
);
CREATE INDEX statuses_card_url ON statuses(json_extract(card,'$.url'),created_at) WHERE card IS NOT NULL;
