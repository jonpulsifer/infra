-- Plaintext columns are ids, batch ids, roles, timestamps of server events and HMAC tokens.
-- Everything a household would call its finances is inside a sealed payload.

CREATE TABLE ledgers (
  id TEXT PRIMARY KEY,
  created TEXT NOT NULL,
  key_version TEXT NOT NULL,
  wrapped_data_key BYTEA NOT NULL,
  wrapped_token_key BYTEA NOT NULL,
  version INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE members (
  ledger_id TEXT NOT NULL REFERENCES ledgers (id) ON DELETE CASCADE,
  login TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'viewer')),
  PRIMARY KEY (ledger_id, login)
);
CREATE INDEX members_login ON members (login);

CREATE TABLE accounts (
  ledger_id TEXT NOT NULL REFERENCES ledgers (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  payload BYTEA NOT NULL,
  PRIMARY KEY (ledger_id, id)
);

CREATE TABLE categories (
  ledger_id TEXT NOT NULL REFERENCES ledgers (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  payload BYTEA NOT NULL,
  PRIMARY KEY (ledger_id, id)
);

CREATE TABLE transactions (
  ledger_id TEXT NOT NULL REFERENCES ledgers (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  dedupe_token BYTEA NOT NULL,
  merchant_token INTEGER NOT NULL,
  payload BYTEA NOT NULL,
  PRIMARY KEY (ledger_id, id)
);
CREATE INDEX transactions_dedupe ON transactions (ledger_id, dedupe_token);
CREATE INDEX transactions_merchant ON transactions (ledger_id, merchant_token);
CREATE INDEX transactions_batch ON transactions (ledger_id, batch_id);

CREATE TABLE rules (
  ledger_id TEXT NOT NULL REFERENCES ledgers (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  payload BYTEA NOT NULL,
  PRIMARY KEY (ledger_id, id)
);

CREATE TABLE assertions (
  ledger_id TEXT NOT NULL REFERENCES ledgers (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  payload BYTEA NOT NULL,
  PRIMARY KEY (ledger_id, id)
);

CREATE TABLE holdings (
  ledger_id TEXT NOT NULL REFERENCES ledgers (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  payload BYTEA NOT NULL,
  PRIMARY KEY (ledger_id, id)
);

CREATE TABLE valuations (
  ledger_id TEXT NOT NULL REFERENCES ledgers (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  payload BYTEA NOT NULL,
  PRIMARY KEY (ledger_id, id)
);

CREATE TABLE batches (
  ledger_id TEXT NOT NULL REFERENCES ledgers (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  payload BYTEA NOT NULL,
  PRIMARY KEY (ledger_id, id)
);

CREATE TABLE previews (
  ledger_id TEXT NOT NULL REFERENCES ledgers (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  created TEXT NOT NULL,
  payload BYTEA NOT NULL,
  PRIMARY KEY (ledger_id, id)
);

CREATE TABLE audit (
  ledger_id TEXT NOT NULL REFERENCES ledgers (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  created TEXT NOT NULL,
  payload BYTEA NOT NULL,
  PRIMARY KEY (ledger_id, id)
);

CREATE TABLE tombstones (
  ledger_id TEXT NOT NULL REFERENCES ledgers (id) ON DELETE CASCADE,
  transaction_id TEXT NOT NULL,
  dedupe_token BYTEA NOT NULL,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (ledger_id, transaction_id)
);
CREATE INDEX tombstones_dedupe ON tombstones (ledger_id, dedupe_token);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL REFERENCES ledgers (id) ON DELETE CASCADE,
  login TEXT NOT NULL,
  token_hash BYTEA NOT NULL UNIQUE,
  created TEXT NOT NULL
);
