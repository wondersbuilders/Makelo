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

  // 2: admin roles, plans, subscriptions and the credits ledger
  `ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
   ALTER TABLE users ADD COLUMN suspended_at INTEGER;
   CREATE TABLE plans (
     id              INTEGER PRIMARY KEY,
     slug            TEXT NOT NULL UNIQUE,
     name            TEXT NOT NULL,
     description     TEXT NOT NULL DEFAULT '',
     price_cents     INTEGER NOT NULL DEFAULT 0,
     currency        TEXT NOT NULL DEFAULT 'GBP',
     interval        TEXT NOT NULL DEFAULT 'month',
     monthly_credits INTEGER NOT NULL DEFAULT 0,
     max_apps        INTEGER NOT NULL DEFAULT 3,
     custom_domains  INTEGER NOT NULL DEFAULT 0,
     stripe_price_id TEXT,
     visible         INTEGER NOT NULL DEFAULT 1,
     archived        INTEGER NOT NULL DEFAULT 0,
     sort            INTEGER NOT NULL DEFAULT 0,
     created_at      INTEGER NOT NULL,
     updated_at      INTEGER NOT NULL
   );
   CREATE TABLE subscriptions (
     user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     plan_id      INTEGER NOT NULL REFERENCES plans(id),
     status       TEXT NOT NULL DEFAULT 'active',
     period_start INTEGER NOT NULL,
     period_end   INTEGER NOT NULL,
     updated_at   INTEGER NOT NULL
   );
   CREATE TABLE credit_ledger (
     id         INTEGER PRIMARY KEY,
     user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     delta      INTEGER NOT NULL,
     kind       TEXT NOT NULL,
     note       TEXT NOT NULL DEFAULT '',
     meta       TEXT,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX credit_ledger_user ON credit_ledger(user_id, created_at);
   CREATE INDEX credit_ledger_time ON credit_ledger(created_at);`,

  // 3: payments through a gateway (Whop): credit packs, memberships, payments, webhook idempotency
  `ALTER TABLE plans RENAME COLUMN stripe_price_id TO gateway_plan_id;
   CREATE TABLE credit_packs (
     id          INTEGER PRIMARY KEY,
     name        TEXT NOT NULL,
     credits     INTEGER NOT NULL,
     price_cents INTEGER NOT NULL,
     currency    TEXT NOT NULL DEFAULT 'GBP',
     visible     INTEGER NOT NULL DEFAULT 1,
     archived    INTEGER NOT NULL DEFAULT 0,
     sort        INTEGER NOT NULL DEFAULT 0,
     created_at  INTEGER NOT NULL,
     updated_at  INTEGER NOT NULL
   );
   CREATE TABLE gateway_memberships (
     user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     membership_id TEXT NOT NULL UNIQUE,
     plan_id       INTEGER NOT NULL REFERENCES plans(id),
     status        TEXT NOT NULL,
     updated_at    INTEGER NOT NULL
   );
   CREATE TABLE payments (
     id           INTEGER PRIMARY KEY,
     user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
     provider     TEXT NOT NULL,
     ref          TEXT NOT NULL UNIQUE,
     kind         TEXT NOT NULL,
     amount_cents INTEGER NOT NULL DEFAULT 0,
     currency     TEXT NOT NULL DEFAULT 'GBP',
     description  TEXT NOT NULL DEFAULT '',
     status       TEXT NOT NULL,
     created_at   INTEGER NOT NULL
   );
   CREATE INDEX payments_time ON payments(created_at);
   CREATE TABLE webhook_events (
     id         TEXT PRIMARY KEY,
     created_at INTEGER NOT NULL
   );`,
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
