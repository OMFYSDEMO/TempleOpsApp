-- In-app login: password credentials, sessions and one-time password tokens.
CREATE TABLE credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  password_hash TEXT NOT NULL,          -- hex, PBKDF2-SHA256
  salt TEXT NOT NULL,                   -- hex, 16 bytes
  iterations INTEGER NOT NULL,
  must_change INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                  -- sha256 of the cookie value
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  last_seen_at TEXT,
  user_agent TEXT,
  revoked_at TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE password_tokens (
  id TEXT PRIMARY KEY,                  -- sha256 of the token in the link
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('invite','reset')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX password_tokens_user ON password_tokens(user_id);
