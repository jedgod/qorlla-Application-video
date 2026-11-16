-- Development-only reference schema. NOT a replacement for production PostgreSQL.
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,owner_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('doc','sheet','slides')),title TEXT NOT NULL,current_version INTEGER NOT NULL DEFAULT 1,deleted_at TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS document_versions(document_id TEXT NOT NULL,version_no INTEGER NOT NULL,content TEXT NOT NULL,source TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(document_id,version_no),FOREIGN KEY(document_id) REFERENCES documents(id));
CREATE TABLE IF NOT EXISTS document_permissions(document_id TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('viewer','editor')),PRIMARY KEY(document_id,user_id));
CREATE TABLE IF NOT EXISTS folders(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,owner_id TEXT NOT NULL,name TEXT NOT NULL,parent_id TEXT);
CREATE TABLE IF NOT EXISTS document_metadata(document_id TEXT PRIMARY KEY,folder_id TEXT,template INTEGER NOT NULL DEFAULT 0,FOREIGN KEY(document_id) REFERENCES documents(id));
CREATE TABLE IF NOT EXISTS stars(document_id TEXT NOT NULL,user_id TEXT NOT NULL,PRIMARY KEY(document_id,user_id));
CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,author_id TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,resolved_at TEXT);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,workspace_id TEXT NOT NULL,document_id TEXT,actor_id TEXT NOT NULL,action TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
