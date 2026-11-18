PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, email TEXT NOT NULL COLLATE NOCASE UNIQUE,
 email_verified INTEGER NOT NULL DEFAULT 0, display_name TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','deleted')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS users_tenant_name ON users(tenant_id,display_name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS number_counters (
 country_iso TEXT PRIMARY KEY, next_serial INTEGER NOT NULL CHECK(next_serial >= 1)
);
CREATE TABLE IF NOT EXISTS numbers (
 user_id TEXT PRIMARY KEY REFERENCES users(id), country_iso TEXT NOT NULL,
 country_code TEXT NOT NULL, serial INTEGER NOT NULL,
 issued_number TEXT NOT NULL UNIQUE, assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(country_iso,serial)
);
CREATE TABLE IF NOT EXISTS extensions (
 tenant_id TEXT NOT NULL, extension TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id),
 PRIMARY KEY(tenant_id,extension), UNIQUE(tenant_id,user_id)
);
CREATE TABLE IF NOT EXISTS calls (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
 caller_id TEXT NOT NULL REFERENCES users(id), callee_id TEXT NOT NULL REFERENCES users(id),
 media_type TEXT NOT NULL CHECK(media_type IN ('audio','video')),
 status TEXT NOT NULL CHECK(status IN ('ringing','accepted','rejected','ended','expired')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS calls_caller_idx ON calls(caller_id,created_at DESC);
CREATE INDEX IF NOT EXISTS calls_callee_idx ON calls(callee_id,created_at DESC);
CREATE TABLE IF NOT EXISTS audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, action TEXT NOT NULL,
 subject_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
