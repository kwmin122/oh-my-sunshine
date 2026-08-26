import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface DbConfig {
  dataDir: string;
}

/** Opens (and migrates) the local SQLite database in WAL mode.
 * node:sqlite keeps V1 zero-native-dependency; the StorageAdapter seam below is what
 * a future PostgreSQL adapter would implement.
 */
export function openDatabase(cfg: DbConfig): DatabaseSync {
  mkdirSync(cfg.dataDir, { recursive: true });
  const db = new DatabaseSync(join(cfg.dataDir, "devflow.sqlite"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

/** Graceful-shutdown DB close (§25): checkpoint WAL into the main file so the
 * on-disk artifact is self-contained and restart-safe, then close cleanly. */
export function closeDatabase(db: DatabaseSync): void {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    db.close();
  }
}

function migrate(db: DatabaseSync): void {
  // Append-only audit stream. Timeline/replay derives exclusively from here.
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      payload TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      UNIQUE(project_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_events_project_seq ON events(project_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
  `);
  // Document-style storage for aggregates. JSON payloads are validated by
  // repositories on hydration, keeping this layer schema-agnostic.
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      kind TEXT NOT NULL,
      id TEXT NOT NULL,
      project_id TEXT,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (kind, id)
    );
    CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(kind, project_id);
  `);
  // Idempotency keys (V3 §9/§31): replay-safe mutating requests.
  db.exec(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT NOT NULL,
      method TEXT NOT NULL,
      url TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      response TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (key, method, url)
    );
  `);
}
