import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createServer, listen } from "../src/api";
import { createSeries, getSamples, runCount, getReport, listReports } from "../src/db";
import type http from "node:http";

process.env.RAINFLOW_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rainflow-test-"));

let server: http.Server;
let base = "";

before(async () => {
  server = createServer();
  const port = await listen(server, 0);
  base = `http://127.0.0.1:${port}`;
});

after(() => server.close());

test("数据库往返：导入 -> 计数 -> 读取报告", () => {
  const s = createSeries("t1", [0, 3, 1, 4, 0]);
  assert.deepEqual(getSamples(s.id), [0, 3, 1, 4, 0]);
  const { reportId } = runCount(s.id);
  const r = getReport(reportId)!;
  assert.equal((r.report as unknown as { status: string }).status, "complete");
  assert.equal(r.cycles.length, 3);
  assert.equal(r.spectrum.length, 2);
  assert.equal(listReports(s.id).length, 1);
});

test("修订产生新序列，不覆盖原始数据", () => {
  const s1 = createSeries("rev", [0, 1, 0]);
  const s2 = createSeries("rev", [0, 2, 0], s1.id);
  assert.equal(s2.revision, 2);
  assert.deepEqual(getSamples(s1.id), [0, 1, 0]);
  assert.deepEqual(getSamples(s2.id), [0, 2, 0]);
});

test("API 全流程", async () => {
  const imp = await fetch(`${base}/series`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "api", values: [0, 3, 1, 4, 0] }),
  });
  assert.equal(imp.status, 201);
  const { series } = (await imp.json()) as { series: { id: number } };

  const tp = await fetch(`${base}/series/${series.id}/turning-points`);
  const tpBody = (await tp.json()) as { turningPoints: unknown[] };
  assert.equal(tpBody.turningPoints.length, 5);

  const cnt = await fetch(`${base}/series/${series.id}/count`, { method: "POST" });
  assert.equal(cnt.status, 201);
  const { reportId } = (await cnt.json()) as { reportId: number };

  const rep = await fetch(`${base}/reports/${reportId}`);
  const repBody = (await rep.json()) as { cycles: unknown[]; spectrum: unknown[] };
  assert.equal(repBody.cycles.length, 3);
  assert.equal(repBody.spectrum.length, 2);

  const stack = await fetch(`${base}/reports/${reportId}/stack`);
  const stackBody = (await stack.json()) as { events: unknown[] };
  assert.ok(stackBody.events.length > 0);

  const csv = await fetch(`${base}/reports/${reportId}/export?format=csv&section=spectrum`);
  const text = await csv.text();
  assert.match(text, /range,mean2,halfCount/);

  const bad = await fetch(`${base}/series`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "bad", values: [1, 2.5] }),
  });
  assert.equal(bad.status, 400);
  const badBody = (await bad.json()) as { error: { code: string } };
  assert.equal(badBody.error.code, "E_BAD_VALUE");

  const missing = await fetch(`${base}/reports/99999`);
  assert.equal(missing.status, 404);
});

test("API 比较两个版本", async () => {
  const imp = async (values: number[], revisionOf?: number) => {
    const res = await fetch(`${base}/series`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "cmp", values, revisionOf }),
    });
    return ((await res.json()) as { series: { id: number } }).series.id;
  };
  const a = await imp([0, 1, 0]);
  const b = await imp([0, 2, 0], a);
  const res = await fetch(`${base}/compare?a=${a}&b=${b}`);
  const body = (await res.json()) as { diffCount: number; diffs: { seq: number }[] };
  assert.equal(body.diffCount, 1);
  assert.equal(body.diffs[0].seq, 1);
});
