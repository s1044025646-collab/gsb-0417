import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db";
import { RainflowService } from "../src/service";
import { createServer } from "../src/server";
import { AddressInfo } from "node:net";

function makeService() {
  return new RainflowService(openDb(":memory:"));
}

test("导入、计数、报告持久化", () => {
  const svc = makeService();
  const seq = svc.importSequence("t", [0, 3, 1, 4, 0]);
  const r = svc.runCount(seq.id);
  assert.equal(r.cycleCount, 3);
  const rep = svc.getReport(r.reportId) as any;
  assert.equal(rep.status, "completed");
  assert.equal(rep.spectrum.length, 2);
  const cycles = svc.getCycles(r.reportId).cycles as any[];
  assert.equal(cycles.length, 3);
  const stack = svc.getStackEvents(r.reportId).events as any[];
  assert.ok(stack.length > 0);
});

test("修订产生新序列，不覆盖原始数据", () => {
  const svc = makeService();
  const a = svc.importSequence("v1", [0, 3, 1, 4, 0]);
  const b = svc.importSequence("v2", [0, 3, 1, 5, 0], a.id);
  assert.notEqual(a.id, b.id);
  const cmp = svc.compareSequences(a.id, b.id) as any;
  assert.equal(cmp.identical, false);
  assert.equal(cmp.firstDiffIndex, 3);
  const orig = svc.getSequence(a.id) as any;
  assert.equal(orig.samples.length, 5);
  assert.equal(orig.samples[3].value, 4);
});

test("非法载荷报错且不留下序列", () => {
  const svc = makeService();
  assert.throws(() => svc.importSequence("bad", [1, 1.5, 3]), /安全整数/);
  assert.throws(() => svc.importSequence("bad2", "nope"), /整数数组/);
  assert.equal((svc.listSequences() as any[]).length, 0);
});

test("超长输入被拒绝", () => {
  const svc = makeService();
  const big = new Array(100001).fill(1);
  assert.throws(() => svc.importSequence("big", big), /上限/);
});

test("HTTP API 端到端", async () => {
  const svc = makeService();
  const server = createServer(svc);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const post = async (path: string, body?: unknown) => {
      const res = await fetch(base + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };
    const imp = await post("/api/sequences", { name: "api", values: [0, 3, 1, 4, 0] });
    assert.equal(imp.status, 201);
    const seqId = imp.body.id;
    const cnt = await post(`/api/sequences/${seqId}/count`);
    assert.equal(cnt.status, 201);
    assert.equal(cnt.body.cycleCount, 3);
    const rep = await fetch(`${base}/api/reports/${cnt.body.reportId}`);
    assert.equal(rep.status, 200);
    const csv = await fetch(`${base}/api/reports/${cnt.body.reportId}/export?format=csv`);
    assert.match(await csv.text(), /order,range,mean2/);
    const bad = await post("/api/sequences", { name: "x", values: [1.2] });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "INVALID_INPUT");
    const missing = await fetch(`${base}/api/reports/999`);
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});
