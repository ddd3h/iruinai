const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#4f7cff',
    icon_path TEXT
  );
  CREATE TABLE IF NOT EXISTS stays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    start TEXT NOT NULL,
    end TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_stays_start ON stays(start);
  CREATE INDEX IF NOT EXISTS idx_stays_person ON stays(person_id);
  -- person_id が NULL のメモは「部屋」のメモ
  CREATE TABLE IF NOT EXISTS memos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id INTEGER REFERENCES people(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    all_day INTEGER NOT NULL DEFAULT 0,
    start TEXT NOT NULL,
    end TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memos_start ON memos(start);
  CREATE INDEX IF NOT EXISTS idx_memos_person ON memos(person_id);

  -- アカウント。1アカウント = 1人。人が消えるとアカウントも消える
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    person_id INTEGER NOT NULL UNIQUE REFERENCES people(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  -- メール確認前の登録（コードを確認するまで users には入れない）
  CREATE TABLE IF NOT EXISTS pending_signups (
    email TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    person_id INTEGER,
    new_name TEXT,
    new_color TEXT,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    sent_at INTEGER NOT NULL,
    resend_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS reset_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_reset_user ON reset_tokens(user_id);
`);

// このブランチの途中で作られた DB には resend_count がないので、足す（新しい DB では CREATE TABLE で作られている）
if (!db.prepare('PRAGMA table_info(pending_signups)').all().some((c) => c.name === 'resend_count')) {
  db.exec('ALTER TABLE pending_signups ADD COLUMN resend_count INTEGER NOT NULL DEFAULT 0');
}

function inTransaction(fn) {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { db, DATA_DIR, UPLOAD_DIR, inTransaction };
