import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

export function openDb(dbPath: string): DatabaseSync {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS sequences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      parent_id INTEGER REFERENCES sequences(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      sample_count INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS samples (
      seq_id INTEGER NOT NULL REFERENCES sequences(id),
      idx INTEGER NOT NULL,
      value INTEGER NOT NULL,
      PRIMARY KEY (seq_id, idx)
    );
    CREATE TABLE IF NOT EXISTS turning_points (
      seq_id INTEGER NOT NULL REFERENCES sequences(id),
      tp_idx INTEGER NOT NULL,
      orig_idx INTEGER NOT NULL,
      value INTEGER NOT NULL,
      PRIMARY KEY (seq_id, tp_idx)
    );
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seq_id INTEGER NOT NULL REFERENCES sequences(id),
      algo_version TEXT NOT NULL,
      platform_rule TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      cycle_count INTEGER NOT NULL DEFAULT 0,
      half_units_total INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS cycles (
      report_id INTEGER NOT NULL REFERENCES reports(id),
      ord INTEGER NOT NULL,
      range INTEGER NOT NULL,
      mean2 INTEGER NOT NULL,
      weight INTEGER NOT NULL,
      from_tp INTEGER NOT NULL,
      to_tp INTEGER NOT NULL,
      from_orig INTEGER NOT NULL,
      to_orig INTEGER NOT NULL,
      from_value INTEGER NOT NULL,
      to_value INTEGER NOT NULL,
      triggered_by_orig INTEGER NOT NULL,
      residual INTEGER NOT NULL,
      PRIMARY KEY (report_id, ord)
    );
    CREATE TABLE IF NOT EXISTS spectrum (
      report_id INTEGER NOT NULL REFERENCES reports(id),
      range INTEGER NOT NULL,
      mean2 INTEGER NOT NULL,
      half_units INTEGER NOT NULL,
      PRIMARY KEY (report_id, range, mean2)
    );
    CREATE TABLE IF NOT EXISTS stack_events (
      report_id INTEGER NOT NULL REFERENCES reports(id),
      step INTEGER NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL,
      stack_json TEXT NOT NULL,
      PRIMARY KEY (report_id, step)
    );
  `);
  return db;
}

export function defaultDbPath(): string {
  return path.join(process.cwd(), "data", "rainflow.db");
}
