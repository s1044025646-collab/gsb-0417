import { DatabaseSync } from "node:sqlite";
import { preprocess, PLATFORM_RULE } from "./core/preprocess";
import { ALGO_VERSION, buildSpectrum, rainflow } from "./core/rainflow";
import { ApiError, MAX_DISPLAY, validateValues } from "./errors";
import { CycleRecord, SpectrumRow } from "./core/types";

export class RainflowService {
  constructor(private db: DatabaseSync) {}

  importSequence(name: string, valuesRaw: unknown, parentId?: number) {
    const values = validateValues(valuesRaw);
    if (typeof name !== "string" || name.trim() === "") {
      throw new ApiError("INVALID_INPUT", "name 不能为空");
    }
    if (parentId !== undefined) {
      const parent = this.db
        .prepare("SELECT id FROM sequences WHERE id = ?")
        .get(parentId);
      if (!parent) throw new ApiError("NOT_FOUND", `父序列 ${parentId} 不存在`, 404);
    }
    const { turningPoints } = preprocess(values);
    this.db.exec("BEGIN");
    try {
      const r = this.db
        .prepare("INSERT INTO sequences (name, parent_id, sample_count) VALUES (?, ?, ?)")
        .run(name.trim(), parentId ?? null, values.length);
      const seqId = Number(r.lastInsertRowid);
      const insSample = this.db.prepare(
        "INSERT INTO samples (seq_id, idx, value) VALUES (?, ?, ?)"
      );
      values.forEach((v, i) => insSample.run(seqId, i, v));
      const insTp = this.db.prepare(
        "INSERT INTO turning_points (seq_id, tp_idx, orig_idx, value) VALUES (?, ?, ?, ?)"
      );
      for (const tp of turningPoints) insTp.run(seqId, tp.tpIndex, tp.origIndex, tp.value);
      this.db.exec("COMMIT");
      return { id: seqId, name: name.trim(), parentId: parentId ?? null, sampleCount: values.length, turningPointCount: turningPoints.length };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  listSequences() {
    return this.db
      .prepare(
        `SELECT s.id, s.name, s.parent_id AS parentId, s.created_at AS createdAt,
                s.sample_count AS sampleCount,
                (SELECT COUNT(*) FROM turning_points t WHERE t.seq_id = s.id) AS turningPointCount,
                (SELECT COUNT(*) FROM reports r WHERE r.seq_id = s.id AND r.status = 'completed') AS reportCount
         FROM sequences s ORDER BY s.id`
      )
      .all();
  }

  private requireSequence(seqId: number) {
    const seq = this.db
      .prepare(
        "SELECT id, name, parent_id AS parentId, created_at AS createdAt, sample_count AS sampleCount FROM sequences WHERE id = ?"
      )
      .get(seqId);
    if (!seq) throw new ApiError("NOT_FOUND", `序列 ${seqId} 不存在`, 404);
    return seq;
  }

  getSequence(seqId: number, limit = MAX_DISPLAY, offset = 0) {
    const seq = this.requireSequence(seqId);
    const samples = this.db
      .prepare("SELECT idx, value FROM samples WHERE seq_id = ? ORDER BY idx LIMIT ? OFFSET ?")
      .all(seqId, limit, offset);
    return { ...seq, limit, offset, samples };
  }

  getTurningPoints(seqId: number, limit = MAX_DISPLAY, offset = 0) {
    this.requireSequence(seqId);
    const points = this.db
      .prepare(
        "SELECT tp_idx AS tpIndex, orig_idx AS origIndex, value FROM turning_points WHERE seq_id = ? ORDER BY tp_idx LIMIT ? OFFSET ?"
      )
      .all(seqId, limit, offset);
    return { seqId, platformRule: PLATFORM_RULE, limit, offset, turningPoints: points };
  }

  runCount(seqId: number) {
    this.requireSequence(seqId);
    const rows = this.db
      .prepare("SELECT value FROM samples WHERE seq_id = ? ORDER BY idx")
      .all(seqId) as { value: number }[];
    const values = rows.map((r) => r.value);
    const { turningPoints } = preprocess(values);
    const result = rainflow(turningPoints);
    const spectrum = buildSpectrum(result.cycles);
    const halfTotal = result.cycles.reduce((s, c) => s + c.weight, 0);

    this.db.exec("BEGIN");
    try {
      const r = this.db
        .prepare(
          "INSERT INTO reports (seq_id, algo_version, platform_rule, status, cycle_count, half_units_total) VALUES (?, ?, ?, 'running', 0, 0)"
        )
        .run(seqId, ALGO_VERSION, PLATFORM_RULE);
      const reportId = Number(r.lastInsertRowid);
      const insCycle = this.db.prepare(
        `INSERT INTO cycles (report_id, ord, range, mean2, weight, from_tp, to_tp, from_orig, to_orig, from_value, to_value, triggered_by_orig, residual)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const c of result.cycles) {
        insCycle.run(reportId, c.order, c.range, c.mean2, c.weight, c.fromTpIndex, c.toTpIndex,
          c.fromOrigIndex, c.toOrigIndex, c.fromValue, c.toValue, c.triggeredByOrigIndex, c.residual ? 1 : 0);
      }
      const insSpec = this.db.prepare(
        "INSERT INTO spectrum (report_id, range, mean2, half_units) VALUES (?, ?, ?, ?)"
      );
      for (const s of spectrum) insSpec.run(reportId, s.range, s.mean2, s.halfUnits);
      const insEv = this.db.prepare(
        "INSERT INTO stack_events (report_id, step, action, detail, stack_json) VALUES (?, ?, ?, ?, ?)"
      );
      for (const ev of result.stackEvents) {
        insEv.run(reportId, ev.step, ev.action, ev.detail, JSON.stringify(ev.stack));
      }
      this.db
        .prepare(
          "UPDATE reports SET status = 'completed', cycle_count = ?, half_units_total = ? WHERE id = ?"
        )
        .run(result.cycles.length, halfTotal, reportId);
      this.db.exec("COMMIT");
      return { reportId, seqId, algoVersion: ALGO_VERSION, cycleCount: result.cycles.length, halfUnitsTotal: halfTotal, spectrum };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  private requireReport(reportId: number) {
    const rep = this.db
      .prepare(
        `SELECT id, seq_id AS seqId, algo_version AS algoVersion, platform_rule AS platformRule,
                status, created_at AS createdAt, cycle_count AS cycleCount, half_units_total AS halfUnitsTotal
         FROM reports WHERE id = ?`
      )
      .get(reportId);
    if (!rep) throw new ApiError("NOT_FOUND", `报告 ${reportId} 不存在`, 404);
    return rep as { status: string } & Record<string, unknown>;
  }

  getReport(reportId: number) {
    const rep = this.requireReport(reportId);
    const spectrum = this.db
      .prepare("SELECT range, mean2, half_units AS halfUnits FROM spectrum WHERE report_id = ? ORDER BY range, mean2")
      .all(reportId);
    return { ...rep, spectrum };
  }

  getCycles(reportId: number, limit = MAX_DISPLAY, offset = 0) {
    const rep = this.requireReport(reportId);
    if (rep.status !== "completed") {
      throw new ApiError("CONFLICT", `报告 ${reportId} 未完成，状态 ${rep.status}`, 409);
    }
    const cycles = this.db
      .prepare(
        `SELECT ord AS "order", range, mean2, weight, from_tp AS fromTp, to_tp AS toTp,
                from_orig AS fromOrig, to_orig AS toOrig, from_value AS fromValue, to_value AS toValue,
                triggered_by_orig AS triggeredByOrig, residual
         FROM cycles WHERE report_id = ? ORDER BY ord LIMIT ? OFFSET ?`
      )
      .all(reportId, limit, offset);
    return { reportId, limit, offset, cycles };
  }

  getStackEvents(reportId: number, limit = MAX_DISPLAY, offset = 0) {
    const rep = this.requireReport(reportId);
    if (rep.status !== "completed") {
      throw new ApiError("CONFLICT", `报告 ${reportId} 未完成，状态 ${rep.status}`, 409);
    }
    const rows = this.db
      .prepare(
        "SELECT step, action, detail, stack_json AS stackJson FROM stack_events WHERE report_id = ? ORDER BY step LIMIT ? OFFSET ?"
      )
      .all(reportId, limit, offset) as { stackJson: string }[];
    return {
      reportId,
      limit,
      offset,
      events: rows.map((r) => ({ ...r, stack: JSON.parse(r.stackJson), stackJson: undefined })),
    };
  }

  compareSequences(aId: number, bId: number) {
    this.requireSequence(aId);
    this.requireSequence(bId);
    const a = this.db.prepare("SELECT idx, value FROM samples WHERE seq_id = ? ORDER BY idx").all(aId) as { idx: number; value: number }[];
    const b = this.db.prepare("SELECT idx, value FROM samples WHERE seq_id = ? ORDER BY idx").all(bId) as { idx: number; value: number }[];
    let firstDiff = -1;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (a[i].value !== b[i].value) { firstDiff = i; break; }
    }
    if (firstDiff === -1 && a.length !== b.length) firstDiff = n;
    const latestReport = (seqId: number) =>
      this.db
        .prepare("SELECT id FROM reports WHERE seq_id = ? AND status = 'completed' ORDER BY id DESC LIMIT 1")
        .get(seqId) as { id: number } | undefined;
    const ra = latestReport(aId);
    const rb = latestReport(bId);
    let spectrumDiff: unknown = null;
    if (ra && rb) {
      const specOf = (rid: number) =>
        this.db.prepare("SELECT range, mean2, half_units AS halfUnits FROM spectrum WHERE report_id = ? ORDER BY range, mean2").all(rid) as unknown as SpectrumRow[];
      const sa = specOf(ra.id);
      const sb = specOf(rb.id);
      spectrumDiff = {
        reportA: ra.id,
        reportB: rb.id,
        identical: JSON.stringify(sa) === JSON.stringify(sb),
        spectrumA: sa,
        spectrumB: sb,
      };
    }
    return {
      a: aId,
      b: bId,
      lengthA: a.length,
      lengthB: b.length,
      identical: firstDiff === -1,
      firstDiffIndex: firstDiff,
      spectrumDiff,
    };
  }

  exportReport(reportId: number, format: "csv" | "json") {
    const rep = this.requireReport(reportId);
    if (rep.status !== "completed") {
      throw new ApiError("CONFLICT", `报告 ${reportId} 未完成，状态 ${rep.status}`, 409);
    }
    const cycles = this.getCycles(reportId, Number.MAX_SAFE_INTEGER).cycles as any[];
    const spectrum = this.db
      .prepare("SELECT range, mean2, half_units AS halfUnits FROM spectrum WHERE report_id = ? ORDER BY range, mean2")
      .all(reportId);
    if (format === "json") {
      return { contentType: "application/json", body: JSON.stringify({ report: rep, cycles, spectrum }, null, 2) };
    }
    const esc = (v: unknown) => {
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines: string[] = ["# cycles", "order,range,mean2,weight,from_orig,to_orig,from_value,to_value,triggered_by_orig,residual"];
    for (const c of cycles) {
      lines.push([c.order, c.range, c.mean2, c.weight, c.fromOrig, c.toOrig, c.fromValue, c.toValue, c.triggeredByOrig, c.residual].map(esc).join(","));
    }
    lines.push("# spectrum", "range,mean2,half_units");
    for (const s of spectrum as any[]) {
      lines.push([s.range, s.mean2, s.halfUnits].map(esc).join(","));
    }
    return { contentType: "text/csv", body: lines.join("\r\n") + "\r\n" };
  }
}
