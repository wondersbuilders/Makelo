import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const MIGRATIONS = [
  `CREATE TABLE users (
     id            INTEGER PRIMARY KEY,
     email         TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL,
     created_at    INTEGER NOT NULL
   );
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY,
     user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     expires_at INTEGER NOT NULL
   );
   CREATE TABLE api_tokens (
     token_hash TEXT PRIMARY KEY,
     user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name       TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE sites (
     id             INTEGER PRIMARY KEY,
     user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name           TEXT NOT NULL,
     slug           TEXT NOT NULL UNIQUE,
     chat_id        TEXT,
     current_deploy INTEGER,
     created_at     INTEGER NOT NULL,
     updated_at     INTEGER NOT NULL
   );
   CREATE UNIQUE INDEX sites_user_chat ON sites(user_id, chat_id) WHERE chat_id IS NOT NULL;
   CREATE TABLE deploys (
     id         INTEGER PRIMARY KEY,
     site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
     file_count INTEGER NOT NULL,
     bytes      INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE domains (
     id           INTEGER PRIMARY KEY,
     site_id      INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
     hostname     TEXT NOT NULL,
     verify_token TEXT NOT NULL,
     verified_at  INTEGER,
     created_at   INTEGER NOT NULL
   );
   -- Many people may *claim* a domain, but only one can prove ownership via DNS.
   CREATE UNIQUE INDEX domains_verified_host ON domains(hostname) WHERE verified_at IS NOT NULL;
   CREATE UNIQUE INDEX domains_site_host ON domains(site_id, hostname);`,
];

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });

  const db = new Database(path.join(dataDir, 'makelo.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  const version = db.pragma('user_version', { simple: true });

  for (let i = version; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }

  return db;
}

export const now = () => Date.now();
