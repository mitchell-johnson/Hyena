-- Preserve the original owner and every existing foreign key while removing
-- the prototype's singleton-account restriction. D1 applies migrations atomically.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE accounts_next (
 id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE,
 domain TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
 display_name TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
 password_hash TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
 owner_slot INTEGER UNIQUE CHECK(owner_slot IS NULL OR owner_slot=1),
 uri TEXT UNIQUE, url TEXT, inbox TEXT, shared_inbox TEXT, outbox TEXT,
 followers_url TEXT, following_url TEXT,
 locked INTEGER NOT NULL DEFAULT 1, bot INTEGER NOT NULL DEFAULT 0,
 discoverable INTEGER NOT NULL DEFAULT 0, indexable INTEGER NOT NULL DEFAULT 0,
 avatar TEXT, header TEXT, fields TEXT NOT NULL DEFAULT '[]',
 preferences TEXT NOT NULL DEFAULT '{}', public_keys TEXT NOT NULL DEFAULT '[]',
 private_keys TEXT, aliases TEXT NOT NULL DEFAULT '[]', moved_to_id TEXT,
 role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','moderator','admin')),
 email TEXT, email_confirmed INTEGER NOT NULL DEFAULT 0,
 approved INTEGER NOT NULL DEFAULT 1, disabled INTEGER NOT NULL DEFAULT 0,
 suspended INTEGER NOT NULL DEFAULT 0, silenced INTEGER NOT NULL DEFAULT 0,
 sensitive INTEGER NOT NULL DEFAULT 0, last_seen_at TEXT,
 UNIQUE(username,domain)
);
INSERT INTO accounts_next(id,username,display_name,note,password_hash,created_at,owner_slot,role)
 SELECT id,username,display_name,note,password_hash,created_at,owner_slot,'admin' FROM accounts;
DROP TABLE accounts;
ALTER TABLE accounts_next RENAME TO accounts;
CREATE INDEX accounts_domain ON accounts(domain);
CREATE INDEX accounts_discovery ON accounts(discoverable,suspended,created_at);

ALTER TABLE statuses ADD COLUMN uri TEXT;
ALTER TABLE statuses ADD COLUMN url TEXT;
ALTER TABLE statuses ADD COLUMN local INTEGER NOT NULL DEFAULT 1;
ALTER TABLE statuses ADD COLUMN reblog_of_id TEXT REFERENCES statuses(id);
ALTER TABLE statuses ADD COLUMN quote_id TEXT REFERENCES statuses(id);
ALTER TABLE statuses ADD COLUMN quote_state TEXT;
ALTER TABLE statuses ADD COLUMN quote_policy TEXT NOT NULL DEFAULT 'public';
ALTER TABLE statuses ADD COLUMN quote_authorization TEXT;
ALTER TABLE statuses ADD COLUMN application_id TEXT REFERENCES oauth_apps(id);
ALTER TABLE statuses ADD COLUMN conversation_id TEXT;
ALTER TABLE statuses ADD COLUMN card TEXT;
CREATE UNIQUE INDEX statuses_uri ON statuses(uri) WHERE uri IS NOT NULL;
CREATE UNIQUE INDEX statuses_boost ON statuses(account_id,reblog_of_id) WHERE reblog_of_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX statuses_conversation ON statuses(conversation_id,sequence);
ALTER TABLE media_attachments ADD COLUMN remote_url TEXT;
ALTER TABLE media_attachments ADD COLUMN preview_remote_url TEXT;
ALTER TABLE media_attachments ADD COLUMN scheduled_id TEXT;

CREATE TABLE jobs_next (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','queued','processing','done','dead')),
 attempt INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL,
 dispatch_until INTEGER, queued_at INTEGER, lease_token TEXT, lease_until INTEGER,
 last_error TEXT, created_at INTEGER NOT NULL, completed_at INTEGER
);
INSERT INTO jobs_next SELECT * FROM jobs;
DROP TABLE jobs;
ALTER TABLE jobs_next RENAME TO jobs;
CREATE INDEX jobs_due ON jobs(available_at) WHERE state IN ('pending','queued','processing');
CREATE INDEX jobs_completed ON jobs(completed_at) WHERE state='done';

CREATE TABLE follows (
 id TEXT NOT NULL UNIQUE, follower_id TEXT NOT NULL REFERENCES accounts(id),
 following_id TEXT NOT NULL REFERENCES accounts(id), state TEXT NOT NULL CHECK(state IN ('pending','accepted')),
 reblogs INTEGER NOT NULL DEFAULT 1, notify INTEGER NOT NULL DEFAULT 0, languages TEXT NOT NULL DEFAULT '[]',
 activity_uri TEXT UNIQUE, created_at TEXT NOT NULL,
 PRIMARY KEY(follower_id,following_id), CHECK(follower_id<>following_id)
);
CREATE INDEX follows_reverse ON follows(following_id,state,follower_id);
CREATE TABLE account_actions (
 id TEXT NOT NULL UNIQUE, account_id TEXT NOT NULL REFERENCES accounts(id),
 target_id TEXT NOT NULL REFERENCES accounts(id),
 kind TEXT NOT NULL CHECK(kind IN ('block','mute','endorse','note','dismiss_suggestion','email_subscription')),
 value TEXT NOT NULL DEFAULT '{}', expires_at INTEGER, created_at TEXT NOT NULL,
 PRIMARY KEY(account_id,target_id,kind)
);
CREATE INDEX actions_reverse ON account_actions(target_id,kind,account_id);
CREATE TABLE user_domain_blocks(account_id TEXT NOT NULL REFERENCES accounts(id),domain TEXT NOT NULL COLLATE NOCASE,PRIMARY KEY(account_id,domain));
CREATE TABLE status_recipients(status_id TEXT NOT NULL REFERENCES statuses(id),account_id TEXT NOT NULL REFERENCES accounts(id),mentioned INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(status_id,account_id));
CREATE INDEX recipients_account ON status_recipients(account_id,status_id);
CREATE TABLE interactions(id TEXT NOT NULL UNIQUE,account_id TEXT NOT NULL REFERENCES accounts(id),status_id TEXT NOT NULL REFERENCES statuses(id),kind TEXT NOT NULL CHECK(kind IN ('favourite','bookmark','mute','pin')),activity_uri TEXT,created_at TEXT NOT NULL,PRIMARY KEY(account_id,status_id,kind));
CREATE INDEX interactions_status ON interactions(status_id,kind,account_id);
CREATE TABLE tags(name TEXT PRIMARY KEY COLLATE NOCASE,display_name TEXT NOT NULL,approved INTEGER NOT NULL DEFAULT 0,usable INTEGER NOT NULL DEFAULT 1,listable INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
CREATE TABLE status_tags(status_id TEXT NOT NULL REFERENCES statuses(id),tag TEXT NOT NULL REFERENCES tags(name),PRIMARY KEY(status_id,tag));
CREATE INDEX status_tags_tag ON status_tags(tag,status_id);
CREATE TABLE account_tags(id TEXT UNIQUE NOT NULL,account_id TEXT NOT NULL REFERENCES accounts(id),tag TEXT NOT NULL REFERENCES tags(name),kind TEXT NOT NULL CHECK(kind IN ('follow','feature')),PRIMARY KEY(account_id,tag,kind));
CREATE TABLE polls(id TEXT PRIMARY KEY,status_id TEXT NOT NULL UNIQUE REFERENCES statuses(id),multiple INTEGER NOT NULL DEFAULT 0,hide_totals INTEGER NOT NULL DEFAULT 0,expires_at TEXT NOT NULL,expired_notified INTEGER NOT NULL DEFAULT 0,options TEXT NOT NULL,remote_votes TEXT NOT NULL DEFAULT '[]');
CREATE TABLE poll_votes(id TEXT NOT NULL UNIQUE,poll_id TEXT NOT NULL REFERENCES polls(id),account_id TEXT NOT NULL REFERENCES accounts(id),choice INTEGER NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(poll_id,account_id,choice));
CREATE TABLE scheduled_statuses(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),params TEXT NOT NULL,scheduled_at TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',status_id TEXT REFERENCES statuses(id),created_at TEXT NOT NULL);
CREATE INDEX schedules_due ON scheduled_statuses(state,scheduled_at);
CREATE TABLE lists(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),title TEXT NOT NULL,replies_policy TEXT NOT NULL DEFAULT 'list',exclusive INTEGER NOT NULL DEFAULT 0);
CREATE TABLE list_accounts(list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,account_id TEXT NOT NULL REFERENCES accounts(id),PRIMARY KEY(list_id,account_id));
CREATE TABLE filters(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),title TEXT NOT NULL,context TEXT NOT NULL,filter_action TEXT NOT NULL CHECK(filter_action IN ('warn','hide')),expires_at TEXT);
CREATE TABLE filter_keywords(id TEXT PRIMARY KEY,filter_id TEXT NOT NULL REFERENCES filters(id) ON DELETE CASCADE,keyword TEXT NOT NULL,whole_word INTEGER NOT NULL DEFAULT 0);
CREATE TABLE filter_statuses(id TEXT PRIMARY KEY,filter_id TEXT NOT NULL REFERENCES filters(id) ON DELETE CASCADE,status_id TEXT NOT NULL REFERENCES statuses(id),UNIQUE(filter_id,status_id));
CREATE TABLE notifications(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),from_account_id TEXT NOT NULL REFERENCES accounts(id),type TEXT NOT NULL,status_id TEXT REFERENCES statuses(id),group_key TEXT NOT NULL,request INTEGER NOT NULL DEFAULT 0,read INTEGER NOT NULL DEFAULT 0,dismissed INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,event_key TEXT NOT NULL UNIQUE);
CREATE INDEX notifications_owner ON notifications(account_id,dismissed,request,id DESC);
CREATE TABLE notification_policies(account_id TEXT PRIMARY KEY REFERENCES accounts(id),policy TEXT NOT NULL DEFAULT '{}');
CREATE TABLE conversations(id TEXT NOT NULL,account_id TEXT NOT NULL REFERENCES accounts(id),last_status_id TEXT REFERENCES statuses(id),unread INTEGER NOT NULL DEFAULT 1,deleted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(id,account_id));
CREATE TABLE markers(account_id TEXT NOT NULL REFERENCES accounts(id),timeline TEXT NOT NULL,last_read_id TEXT NOT NULL,version INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(account_id,timeline));
CREATE TABLE push_subscriptions(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE REFERENCES oauth_tokens(token_hash),account_id TEXT NOT NULL REFERENCES accounts(id),endpoint TEXT NOT NULL,p256dh TEXT NOT NULL,auth TEXT NOT NULL,alerts TEXT NOT NULL,policy TEXT NOT NULL DEFAULT 'all',created_at TEXT NOT NULL);
CREATE TABLE collections(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',uri TEXT UNIQUE,discoverable INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE collection_items(id TEXT PRIMARY KEY,collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,account_id TEXT NOT NULL REFERENCES accounts(id),state TEXT NOT NULL DEFAULT 'pending',authorization TEXT,created_at TEXT NOT NULL,UNIQUE(collection_id,account_id));
CREATE TABLE announcements(id TEXT PRIMARY KEY,content TEXT NOT NULL,starts_at TEXT,ends_at TEXT,all_day INTEGER NOT NULL DEFAULT 0,published_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE announcement_reads(account_id TEXT NOT NULL REFERENCES accounts(id),announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,PRIMARY KEY(account_id,announcement_id));
CREATE TABLE announcement_reactions(account_id TEXT NOT NULL REFERENCES accounts(id),announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,name TEXT NOT NULL,PRIMARY KEY(account_id,announcement_id,name));
CREATE TABLE custom_emojis(id TEXT PRIMARY KEY,shortcode TEXT NOT NULL UNIQUE,url TEXT NOT NULL,static_url TEXT NOT NULL,category TEXT,visible INTEGER NOT NULL DEFAULT 1);
CREATE TABLE reports(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),target_account_id TEXT NOT NULL REFERENCES accounts(id),comment TEXT NOT NULL DEFAULT '',category TEXT NOT NULL DEFAULT 'other',status_ids TEXT NOT NULL DEFAULT '[]',rule_ids TEXT NOT NULL DEFAULT '[]',forwarded INTEGER NOT NULL DEFAULT 0,action_taken INTEGER NOT NULL DEFAULT 0,assigned_account_id TEXT REFERENCES accounts(id),action_taken_by_account_id TEXT REFERENCES accounts(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE moderation_rules(id TEXT PRIMARY KEY,kind TEXT NOT NULL,value TEXT NOT NULL,data TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL,UNIQUE(kind,value));
CREATE TABLE instance_rules(id TEXT PRIMARY KEY,text TEXT NOT NULL,hint TEXT NOT NULL DEFAULT '',position INTEGER NOT NULL DEFAULT 0);
CREATE TABLE audit_log(id TEXT PRIMARY KEY,account_id TEXT REFERENCES accounts(id),action TEXT NOT NULL,target_id TEXT,data TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL);
CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE federation_kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,expires_at INTEGER);
CREATE INDEX federation_kv_expiry ON federation_kv(expires_at);
CREATE TABLE federation_inbox(id TEXT PRIMARY KEY,actor_uri TEXT NOT NULL,activity TEXT NOT NULL,received_at TEXT NOT NULL);
CREATE TABLE delivery_log(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL REFERENCES accounts(id),activity TEXT NOT NULL,recipients TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE email_tokens(hash TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),purpose TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE annual_reports(account_id TEXT NOT NULL REFERENCES accounts(id),year INTEGER NOT NULL,data TEXT NOT NULL,read INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(account_id,year));
CREATE TABLE link_cards(url TEXT PRIMARY KEY,data TEXT NOT NULL,approved INTEGER NOT NULL DEFAULT 0,fetched_at TEXT NOT NULL);
CREATE TABLE async_refreshes(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),status TEXT NOT NULL,result TEXT,created_at TEXT NOT NULL);
PRAGMA defer_foreign_keys = OFF;
