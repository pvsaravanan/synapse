import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { databasePath } from './config.js';

export type DB = DatabaseSyncType;

const require = createRequire(import.meta.url);

/** node:sqlite prints an ExperimentalWarning on load; keep hook/stdio output clean. */
function loadSqlite(): typeof import('node:sqlite') {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const msg = typeof warning === 'string' ? warning : warning?.message;
    if (msg && /SQLite/i.test(msg)) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return require('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS observations (
  id              INTEGER PRIMARY KEY,
  projectId       TEXT NOT NULL,
  entityName      TEXT NOT NULL,
  type            TEXT NOT NULL,
  title           TEXT NOT NULL,
  narrative       TEXT NOT NULL DEFAULT '',
  facts           TEXT NOT NULL DEFAULT '[]',
  filesModified   TEXT NOT NULL DEFAULT '[]',
  concepts        TEXT NOT NULL DEFAULT '[]',
  tokens          INTEGER NOT NULL DEFAULT 0,
  createdAt       TEXT NOT NULL,
  updatedAt       TEXT,
  topicKey        TEXT,
  revisionCount   INTEGER NOT NULL DEFAULT 1,
  sessionId       TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  supersededBy    INTEGER,
  progress        TEXT,
  source          TEXT NOT NULL DEFAULT 'agent',
  commitHash      TEXT,
  relatedCommits  TEXT NOT NULL DEFAULT '[]',
  relatedEntities TEXT NOT NULL DEFAULT '[]',
  admissionState  TEXT NOT NULL DEFAULT 'qualified',
  valueCategory   TEXT,
  hasCausalLanguage INTEGER NOT NULL DEFAULT 0,
  fileHashes      TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(projectId, status);
CREATE INDEX IF NOT EXISTS idx_obs_topic ON observations(projectId, topicKey);
CREATE INDEX IF NOT EXISTS idx_obs_commit ON observations(projectId, commitHash);

CREATE TABLE IF NOT EXISTS observation_access (
  observationId INTEGER PRIMARY KEY,
  accessCount   INTEGER NOT NULL DEFAULT 0,
  lastAccessed  TEXT
);

CREATE TABLE IF NOT EXISTS feedback (
  id            INTEGER PRIMARY KEY,
  observationId INTEGER NOT NULL,
  signal        TEXT NOT NULL,
  note          TEXT,
  createdAt     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_obs ON feedback(observationId);

CREATE TABLE IF NOT EXISTS sessions (
  id        TEXT PRIMARY KEY,
  projectId TEXT NOT NULL,
  startedAt TEXT NOT NULL,
  endedAt   TEXT,
  status    TEXT NOT NULL DEFAULT 'active',
  summary   TEXT,
  agent     TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(projectId, startedAt);

CREATE TABLE IF NOT EXISTS checkpoints (
  id           INTEGER PRIMARY KEY,
  sessionId    TEXT NOT NULL,
  projectId    TEXT NOT NULL,
  createdAt    TEXT NOT NULL,
  summary      TEXT,
  agentSummary TEXT
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(sessionId, id);
CREATE INDEX IF NOT EXISTS idx_checkpoints_project ON checkpoints(projectId, id);

CREATE TABLE IF NOT EXISTS long_term (
  id                  INTEGER PRIMARY KEY,
  projectId           TEXT NOT NULL,
  scope               TEXT NOT NULL DEFAULT 'project',
  kind                TEXT NOT NULL,
  title               TEXT NOT NULL,
  body                TEXT NOT NULL,
  applicability       TEXT,
  evidence            TEXT NOT NULL DEFAULT '[]',
  state               TEXT NOT NULL DEFAULT 'proposed',
  reason              TEXT,
  supersededBy        INTEGER,
  sourceObservationId INTEGER,
  proposedBy          TEXT NOT NULL DEFAULT 'agent',
  createdAt           TEXT NOT NULL,
  reviewedAt          TEXT
);
CREATE INDEX IF NOT EXISTS idx_long_term_project ON long_term(projectId, state);
CREATE INDEX IF NOT EXISTS idx_long_term_scope ON long_term(scope, state);

CREATE VIRTUAL TABLE IF NOT EXISTS long_term_fts USING fts5(
  title, body, applicability,
  content='long_term', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS long_term_fts_ai AFTER INSERT ON long_term BEGIN
  INSERT INTO long_term_fts(rowid, title, body, applicability) VALUES (new.id, new.title, new.body, new.applicability);
END;
CREATE TRIGGER IF NOT EXISTS long_term_fts_ad AFTER DELETE ON long_term BEGIN
  INSERT INTO long_term_fts(long_term_fts, rowid, title, body, applicability) VALUES ('delete', old.id, old.title, old.body, old.applicability);
END;
CREATE TRIGGER IF NOT EXISTS long_term_fts_au AFTER UPDATE OF title, body, applicability ON long_term BEGIN
  INSERT INTO long_term_fts(long_term_fts, rowid, title, body, applicability) VALUES ('delete', old.id, old.title, old.body, old.applicability);
  INSERT INTO long_term_fts(rowid, title, body, applicability) VALUES (new.id, new.title, new.body, new.applicability);
END;

CREATE TABLE IF NOT EXISTS graph_entities (
  projectId  TEXT NOT NULL,
  name       TEXT NOT NULL,
  entityType TEXT NOT NULL,
  observations TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (projectId, name)
);

CREATE TABLE IF NOT EXISTS graph_relations (
  projectId    TEXT NOT NULL,
  fromName     TEXT NOT NULL,
  toName       TEXT NOT NULL,
  relationType TEXT NOT NULL,
  PRIMARY KEY (projectId, fromName, toName, relationType)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  entityName, title, narrative, facts, filesModified, concepts,
  content='observations', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS observations_fts_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, entityName, title, narrative, facts, filesModified, concepts)
  VALUES (new.id, new.entityName, new.title, new.narrative, new.facts, new.filesModified, new.concepts);
END;
CREATE TRIGGER IF NOT EXISTS observations_fts_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, entityName, title, narrative, facts, filesModified, concepts)
  VALUES ('delete', old.id, old.entityName, old.title, old.narrative, old.facts, old.filesModified, old.concepts);
END;
CREATE TRIGGER IF NOT EXISTS observations_fts_au AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, entityName, title, narrative, facts, filesModified, concepts)
  VALUES ('delete', old.id, old.entityName, old.title, old.narrative, old.facts, old.filesModified, old.concepts);
  INSERT INTO observations_fts(rowid, entityName, title, narrative, facts, filesModified, concepts)
  VALUES (new.id, new.entityName, new.title, new.narrative, new.facts, new.filesModified, new.concepts);
END;
`;

let shared: DB | null = null;

export function openDatabase(file: string = databasePath()): DB {
  const { DatabaseSync } = loadSqlite();
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Columns added after the first release; CREATE TABLE IF NOT EXISTS leaves older databases without them. */
function migrate(db: DB): void {
  const cols = new Set((db.prepare('PRAGMA table_info(observations)').all() as { name: string }[]).map((c) => c.name));
  if (!cols.has('fileHashes')) addColumn(db, "ALTER TABLE observations ADD COLUMN fileHashes TEXT NOT NULL DEFAULT '{}'");
}

/** Hooks and MCP servers can open an old database at the same moment; whoever loses the race finds the column already there. */
function addColumn(db: DB, sql: string): void {
  try {
    db.exec(sql);
  } catch (e) {
    if (!/duplicate column/i.test((e as Error).message)) throw e;
  }
}

/** Process-wide database handle. */
export function getDb(): DB {
  if (!shared) shared = openDatabase();
  return shared;
}

/** Replace the shared handle (tests). */
export function setDb(db: DB | null): void {
  shared = db;
}

export function getMeta(db: DB, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
