import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const file = process.env.DB_PATH || './data/shortlink.db';
fs.mkdirSync(path.dirname(file), { recursive: true });

export const db = new Database(file);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS links (
  code        TEXT PRIMARY KEY,
  url         TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT,
  clicks      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS clicks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL REFERENCES links(code) ON DELETE CASCADE,
  clicked_at  TEXT NOT NULL,
  referrer    TEXT,
  device      TEXT,
  browser     TEXT,
  ip_hash     TEXT
);
CREATE INDEX IF NOT EXISTS idx_clicks_code ON clicks(code, clicked_at);
`);
