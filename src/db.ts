import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { ALGORITHM_VERSION, PLATFORM_RULE, CountResult, countCycles } from "./rainflow";

let db: DatabaseSync | null = null;

export function dataDir(): string {
  return process.env.RAINFLOW_DATA_DIR
    ? path.resolve(process.env.RAINFLOW_DATA_DIR)
    : path.join(process.cwd(), "data");
}

export function getDb(): DatabaseSync {
  if (!db) {
    fs.mkdirSync(dataDir(), { recursive: true });
    db = new DatabaseSync(path.join(dataDir(), "rainflow.db"));
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    migrate(db);
  }
  return db;
}

function migrate(d: DatabaseSync): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS series (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      revision_of INTEGER REFERENCES series(id),
      revision INTEGER NOT NULL DEFAULT 1,
      length INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS samples (
      series_id INTEGER NOT NULL REFERENCES series(id),
      seq INTEGER NOT NULL,
      value INTEGER NOT NULL,
      PRIMARY KEY (series_id, seq)
    );
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      series_id INTEGER NOT NULL REFERENCES series(id),
      algorithm_version TEXT NOT NULL,
      platform_rule TEXT NOT NULL,
      status TEXT NOT NULL,
      total_half_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS turning_points (
      report_id INTEGER NOT NULL REFERENCES reports(id),
      tp_index INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      value INTEGER NOT NULL,
      PRIMARY KEY (report_id, tp_index)
    );
    CREATE TABLE IF NOT EXISTS cycles (
      report_id INTEGER NOT NULL REFERENCES reports(id),
      idx INTEGER NOT NULL,
      tp_index1 INTEGER NOT NULL,
      tp_index2 INTEGER NOT NULL,
      seq1 INTEGER NOT NULL,
      seq2 INTEGER NOT NULL,
      value1 INTEGER NOT NULL,
      value2 INTEGER NOT NULL,
      range INTEGER NOT NULL,
      mean2 INTEGER NOT NULL,
      weight INTEGER NOT NULL,
      triggered_by INTEGER NOT NULL,
      kind TEXT NOT NULL,
      PRIMARY KEY (report_id, idx)
    );
    CREATE TABLE IF NOT EXISTS spectrum (
      report_id INTEGER NOT NULL REFERENCES reports(id),
      range INTEGER NOT NULL,
      mean2 INTEGER NOT NULL,
      half_count INTEGER NOT NULL,
      PRIMARY KEY (report_id, range, mean2)
    );
    CREATE TABLE IF NOT EXISTS stack_events (
      report_id INTEGER NOT NULL REFERENCES reports(id),
      step INTEGER NOT NULL,
      action TEXT NOT NULL,
      stack_json TEXT NOT NULL,
      note TEXT NOT NULL,
      PRIMARY KEY (report_id, step)
    );
  `);
}

export interface SeriesRow {
  id: number;
  name: string;
  revision_of: number | null;
  revision: number;
  length: number;
  created_at: string;
}

export function createSeries(name: string, values: number[], revisionOf?: number): SeriesRow {
  const d = getDb();
  d.exec("BEGIN");
  try {
    let revision = 1;
    if (revisionOf !== undefined) {
      const parent = d.prepare("SELECT revision FROM series WHERE id = ?").get(revisionOf) as
        | { revision: number }
        | undefined;
      if (!parent) throw new Error("E_NOT_FOUND: 被修订的序列不存在");
      revision = parent.revision + 1;
    }
    const info = d
      .prepare("INSERT INTO series (name, revision_of, revision, length) VALUES (?, ?, ?, ?)")
      .run(name, revisionOf ?? null, revision, values.length);
    const id = Number(info.lastInsertRowid);
    const ins = d.prepare("INSERT INTO samples (series_id, seq, value) VALUES (?, ?, ?)");
    for (let i = 0; i < values.length; i++) ins.run(id, i, values[i]);
    d.exec("COMMIT");
    return getSeries(id)!;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

export function getSeries(id: number): SeriesRow | null {
  const row = getDb().prepare("SELECT * FROM series WHERE id = ?").get(id);
  return (row as unknown as SeriesRow) ?? null;
}

export function listSeries(): SeriesRow[] {
  return getDb().prepare("SELECT * FROM series ORDER BY id").all() as unknown as SeriesRow[];
}

export function getSamples(id: number): number[] {
  const rows = getDb()
    .prepare("SELECT value FROM samples WHERE series_id = ? ORDER BY seq")
    .all(id) as unknown as { value: number }[];
  return rows.map((r) => r.value);
}

/**
 * 执行计数并落库。整次计算在一个事务内完成：
 * 任何一步失败都会回滚，不会留下貌似完成的部分汇总。
 */
export function runCount(seriesId: number): { reportId: number; result: CountResult } {
  const d = getDb();
  const series = getSeries(seriesId);
  if (!series) throw new Error("E_NOT_FOUND: 序列不存在");
  const values = getSamples(seriesId);
  const result = countCycles(values);

  d.exec("BEGIN");
  try {
    const info = d
      .prepare(
        "INSERT INTO reports (series_id, algorithm_version, platform_rule, status, total_half_count) VALUES (?, ?, ?, 'complete', ?)"
      )
      .run(seriesId, ALGORITHM_VERSION, PLATFORM_RULE, result.totalHalfCount);
    const reportId = Number(info.lastInsertRowid);

    const insTp = d.prepare(
      "INSERT INTO turning_points (report_id, tp_index, seq, value) VALUES (?, ?, ?, ?)"
    );
    result.turningPoints.forEach((tp, i) => insTp.run(reportId, i, tp.seq, tp.value));

    const insCycle = d.prepare(
      "INSERT INTO cycles (report_id, idx, tp_index1, tp_index2, seq1, seq2, value1, value2, range, mean2, weight, triggered_by, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    result.cycles.forEach((c, i) =>
      insCycle.run(
        reportId, i, c.tpIndex1, c.tpIndex2, c.seq1, c.seq2,
        c.value1, c.value2, c.range, c.mean2, c.weight, c.triggeredBy, c.kind
      )
    );

    const insSpec = d.prepare(
      "INSERT INTO spectrum (report_id, range, mean2, half_count) VALUES (?, ?, ?, ?)"
    );
    for (const s of result.spectrum) insSpec.run(reportId, s.range, s.mean2, s.halfCount);

    const insEv = d.prepare(
      "INSERT INTO stack_events (report_id, step, action, stack_json, note) VALUES (?, ?, ?, ?, ?)"
    );
    for (const e of result.events)
      insEv.run(reportId, e.step, e.action, JSON.stringify(e.stack), e.note);

    d.exec("COMMIT");
    return { reportId, result };
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

export function getReport(reportId: number) {
  const d = getDb();
  const report = d.prepare("SELECT * FROM reports WHERE id = ?").get(reportId);
  if (!report) return null;
  const turningPoints = d
    .prepare("SELECT tp_index AS tpIndex, seq, value FROM turning_points WHERE report_id = ? ORDER BY tp_index")
    .all(reportId);
  const cycles = d
    .prepare(
      "SELECT idx, tp_index1 AS tpIndex1, tp_index2 AS tpIndex2, seq1, seq2, value1, value2, range, mean2, weight, triggered_by AS triggeredBy, kind FROM cycles WHERE report_id = ? ORDER BY idx"
    )
    .all(reportId);
  const spectrum = d
    .prepare("SELECT range, mean2, half_count AS halfCount FROM spectrum WHERE report_id = ? ORDER BY range, mean2")
    .all(reportId);
  return { report, turningPoints, cycles, spectrum };
}

export function getStackEvents(reportId: number, limit: number, offset: number) {
  const rows = getDb()
    .prepare(
      "SELECT step, action, stack_json AS stackJson, note FROM stack_events WHERE report_id = ? ORDER BY step LIMIT ? OFFSET ?"
    )
    .all(reportId, limit, offset) as unknown as {
    step: number;
    action: string;
    stackJson: string;
    note: string;
  }[];
  return rows.map((r) => ({
    step: r.step,
    action: r.action,
    stack: JSON.parse(r.stackJson) as number[],
    note: r.note,
  }));
}

export function listReports(seriesId?: number) {
  const d = getDb();
  if (seriesId !== undefined) {
    return d.prepare("SELECT * FROM reports WHERE series_id = ? ORDER BY id").all(seriesId);
  }
  return d.prepare("SELECT * FROM reports ORDER BY id").all();
}
