import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countCycles,
  extractTurningPoints,
  validateSeries,
  ValidationError,
} from "../src/rainflow";

test("演示序列 0,3,1,4,0：一个 range=2 完整循环 + 两个 range=4 半循环，均值均为 2", () => {
  const r = countCycles([0, 3, 1, 4, 0]);
  assert.equal(r.turningPoints.length, 5);
  const full = r.cycles.filter((c) => c.weight === 2);
  const half = r.cycles.filter((c) => c.weight === 1);
  assert.equal(full.length, 1);
  assert.equal(full[0].range, 2);
  assert.equal(full[0].mean2, 4);
  assert.deepEqual([full[0].value1, full[0].value2], [3, 1]);
  assert.equal(half.length, 2);
  for (const h of half) {
    assert.equal(h.range, 4);
    assert.equal(h.mean2, 4);
  }
  assert.equal(r.totalHalfCount, 4);
  assert.deepEqual(
    r.spectrum,
    [
      { range: 2, mean2: 4, halfCount: 2 },
      { range: 4, mean2: 4, halfCount: 2 },
    ]
  );
});

test("单调序列只产生端点残余半循环", () => {
  const r = countCycles([0, 1, 2, 3, 4]);
  assert.equal(r.turningPoints.length, 2);
  assert.equal(r.cycles.length, 1);
  assert.equal(r.cycles[0].kind, "residual");
  assert.equal(r.cycles[0].weight, 1);
  assert.equal(r.cycles[0].range, 4);
});

test("重复平台不增加循环", () => {
  const withPlateau = countCycles([0, 2, 2, 2, 0, 2, 0]);
  const plain = countCycles([0, 2, 0, 2, 0]);
  assert.equal(withPlateau.totalHalfCount, plain.totalHalfCount);
  assert.deepEqual(withPlateau.spectrum, plain.spectrum);
  // 平台中间点被去重，但原始 seq 保留
  const tps = extractTurningPoints([0, 2, 2, 2, 0, 2, 0]);
  assert.deepEqual(
    tps.map((t) => t.seq),
    [0, 1, 4, 5, 6]
  );
});

test("全常量、空序列、单点均无循环", () => {
  for (const v of [[5, 5, 5, 5], [], [7]] as number[][]) {
    const r = countCycles(v);
    assert.equal(r.cycles.length, 0);
    assert.equal(r.totalHalfCount, 0);
    assert.equal(r.spectrum.length, 0);
  }
});

test("相等范围按 X<=Y 结算", () => {
  // 1,3,2,4：X=|3-1|=2 > Y=|2-3|=1 不闭合；再来 4：X=1 <= Y=2，栈四点出完整循环
  const r = countCycles([1, 3, 2, 4]);
  assert.equal(r.cycles.some((c) => c.kind === "full" && c.range === 1), true);
  // 完全等幅振荡：每段范围相等，全部按 X<=Y 规则处理
  const r2 = countCycles([0, 2, 0, 2, 0]);
  assert.equal(r2.totalHalfCount, 4);
});

test("负载荷正常计数", () => {
  const r = countCycles([-3, 2, -1, 4, -3]);
  assert.ok(r.totalHalfCount > 0);
  for (const c of r.cycles) {
    assert.equal(c.mean2, c.value1 + c.value2);
  }
});

test("首尾不同的往返序列：完整循环 + 残余半循环", () => {
  const r = countCycles([0, 4, 0, 4, 2]);
  // 等幅往返 X<=Y 连续出半循环，末尾 4->2 留残余
  assert.equal(r.totalHalfCount, 4);
  assert.ok(r.cycles.some((c) => c.kind === "residual"));
  assert.ok(r.cycles.some((c) => c.kind === "residual" && c.range === 2));
});

test("反复小峰谷被大循环吸收", () => {
  const r = countCycles([0, 10, 1, 2, 1, 2, 0]);
  // 小峰谷 1->2 在 X<=Y 时结算
  assert.ok(r.cycles.some((c) => c.range === 1 && c.weight === 2));
  assert.ok(r.cycles.some((c) => c.range === 10));
});

test("整体平移只改变均值，范围与次数不变", () => {
  const base = [0, 3, 1, 4, 0, 2, 5, 1];
  const shifted = base.map((v) => v + 100);
  const r1 = countCycles(base);
  const r2 = countCycles(shifted);
  assert.equal(r1.cycles.length, r2.cycles.length);
  for (let i = 0; i < r1.cycles.length; i++) {
    assert.equal(r1.cycles[i].range, r2.cycles[i].range);
    assert.equal(r1.cycles[i].weight, r2.cycles[i].weight);
    assert.equal(r2.cycles[i].mean2, r1.cycles[i].mean2 + 200);
  }
});

test("乘正整数同比改变范围与均值，次数不变", () => {
  const base = [0, 3, 1, 4, 0, 2, 5, 1];
  const scaled = base.map((v) => v * 3);
  const r1 = countCycles(base);
  const r2 = countCycles(scaled);
  assert.equal(r1.cycles.length, r2.cycles.length);
  for (let i = 0; i < r1.cycles.length; i++) {
    assert.equal(r2.cycles[i].range, r1.cycles[i].range * 3);
    assert.equal(r2.cycles[i].mean2, r1.cycles[i].mean2 * 3);
    assert.equal(r2.cycles[i].weight, r1.cycles[i].weight);
  }
});

test("原采样顺序决定结果，排序后结果不同", () => {
  const values = [0, 3, 1, 4, 0];
  const sorted = [...values].sort((a, b) => a - b);
  const r1 = countCycles(values);
  const r2 = countCycles(sorted);
  assert.notDeepEqual(r1.spectrum, r2.spectrum);
});

test("手工栈核对：0,3,1,4,0 逐步事件", () => {
  const r = countCycles([0, 3, 1, 4, 0]);
  const actions = r.events.map((e) => e.action);
  // push x5, close-full x1, close-half x1, residual x1
  assert.deepEqual(
    actions.filter((a) => a === "push").length,
    5
  );
  assert.equal(actions.filter((a) => a === "close-full").length, 1);
  assert.equal(actions.filter((a) => a === "close-half").length, 1);
  assert.equal(actions.filter((a) => a === "residual").length, 1);
  // 完整循环由转折点 #3 (值 4) 触发
  const full = r.cycles.find((c) => c.weight === 2)!;
  assert.equal(full.triggeredBy, 3);
});

test("每条循环记录来源转折点与触发点", () => {
  const r = countCycles([2, 5, 1, 6, 3, 0, 4]);
  for (const c of r.cycles) {
    assert.ok(c.seq1 >= 0 && c.seq2 >= 0);
    assert.equal(c.range, Math.abs(c.value2 - c.value1));
    if (c.kind === "residual") assert.equal(c.triggeredBy, -1);
    else assert.ok(c.triggeredBy >= 0);
  }
});

test("输入校验：非整数与超长被拒绝", () => {
  assert.throws(() => validateSeries([1.5]), ValidationError);
  assert.throws(() => validateSeries([1, "a"]), ValidationError);
  assert.throws(() => validateSeries("nope"), ValidationError);
  assert.throws(
    () => validateSeries(new Array(100001).fill(0)),
    (e: unknown) => e instanceof ValidationError && e.code === "E_TOO_LONG"
  );
});

test("半整数均值用 mean2 精确聚合", () => {
  // 0->1 半循环 mean=0.5，mean2=1
  const r = countCycles([0, 1]);
  assert.equal(r.cycles[0].mean2, 1);
  assert.equal(r.spectrum[0].mean2, 1);
});
