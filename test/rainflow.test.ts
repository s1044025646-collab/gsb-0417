import { test } from "node:test";
import assert from "node:assert/strict";
import { preprocess } from "../src/core/preprocess";
import { rainflow, buildSpectrum } from "../src/core/rainflow";

function run(values: number[]) {
  const pre = preprocess(values);
  return { pre, result: rainflow(pre.turningPoints) };
}

test("演示序列 0,3,1,4,0: 内部全循环范围2，残余两半循环范围4，均值均为2", () => {
  const { result } = run([0, 3, 1, 4, 0]);
  assert.equal(result.cycles.length, 3);
  const full = result.cycles.find((c) => c.weight === 2);
  assert.ok(full);
  assert.equal(full.range, 2);
  assert.equal(full.mean2, 4);
  assert.deepEqual([full.fromValue, full.toValue], [3, 1]);
  const halves = result.cycles.filter((c) => c.weight === 1);
  assert.equal(halves.length, 2);
  for (const h of halves) {
    assert.equal(h.range, 4);
    assert.equal(h.mean2, 4);
  }
  const spectrum = buildSpectrum(result.cycles);
  assert.deepEqual(spectrum, [
    { range: 2, mean2: 4, halfUnits: 2 },
    { range: 4, mean2: 4, halfUnits: 2 },
  ]);
});

test("手工栈核对 0,3,1,4,0 的栈变化", () => {
  const { result } = run([0, 3, 1, 4, 0]);
  const actions = result.stackEvents.map((e) => `${e.action}:${e.stack.join(",")}`);
  assert.deepEqual(actions, [
    "push:0",
    "push:0,3",
    "push:0,3,1",
    "push:0,3,1,4",
    "full-cycle:0,4",
    "push:0,4,0",
    "half-cycle:4,0",
    "residual-half-cycle:0",
  ]);
  const full = result.cycles[0];
  assert.equal(full.triggeredByOrigIndex, 3);
  assert.equal(full.fromOrigIndex, 1);
  assert.equal(full.toOrigIndex, 2);
});

test("单调序列只有端点半循环", () => {
  const { result } = run([1, 2, 3, 4, 5]);
  assert.equal(result.cycles.length, 1);
  assert.equal(result.cycles[0].weight, 1);
  assert.equal(result.cycles[0].range, 4);
  assert.ok(result.cycles[0].residual);
});

test("重复平台不增加循环", () => {
  const flat = run([0, 2, 2, 2, 0, 0, 3, 3, 0]);
  const plain = run([0, 2, 0, 3, 0]);
  assert.deepEqual(
    flat.result.cycles.map((c) => [c.range, c.mean2, c.weight]),
    plain.result.cycles.map((c) => [c.range, c.mean2, c.weight])
  );
});

test("相等范围按 X<=Y 结算", () => {
  const { result } = run([0, 2, 0, 2]);
  assert.equal(result.cycles.length, 3);
  assert.ok(result.cycles.every((c) => c.range === 2 && c.weight === 1));
});

test("负载荷", () => {
  const { result } = run([-3, -1, -4, 0, -3]);
  assert.equal(result.cycles.length, 4);
  assert.deepEqual(result.cycles.map((c) => c.range), [2, 3, 4, 3]);
  assert.equal(result.cycles[0].mean2, -4);
  assert.equal(result.cycles[0].weight, 1);
});

test("全常量、空序列、单点均无循环", () => {
  assert.equal(run([5, 5, 5]).result.cycles.length, 0);
  assert.equal(run([]).result.cycles.length, 0);
  assert.equal(run([7]).result.cycles.length, 0);
});

test("首尾不同：残余段各自结算为半循环，不接回开头", () => {
  const { result } = run([0, 4, 1]);
  assert.equal(result.cycles.length, 2);
  assert.ok(result.cycles.every((c) => c.weight === 1 && c.residual));
  assert.deepEqual(result.cycles.map((c) => c.range), [4, 3]);
});

test("反复小峰谷", () => {
  const { result } = run([0, 1, 0, 1, 0, 1, 0]);
  assert.ok(result.cycles.every((c) => c.range === 1));
  const halfUnits = result.cycles.reduce((s, c) => s + c.weight, 0);
  assert.equal(halfUnits, 6);
});

test("整体平移只改变均值", () => {
  const base = run([0, 3, 1, 4, 0]).result.cycles;
  const shifted = run([10, 13, 11, 14, 10]).result.cycles;
  assert.equal(base.length, shifted.length);
  for (let i = 0; i < base.length; i++) {
    assert.equal(base[i].range, shifted[i].range);
    assert.equal(base[i].weight, shifted[i].weight);
    assert.equal(shifted[i].mean2 - base[i].mean2, 20);
  }
});

test("乘正整数同比改变范围与均值，次数不变", () => {
  const base = run([0, 3, 1, 4, 0]).result.cycles;
  const scaled = run([0, 9, 3, 12, 0]).result.cycles;
  assert.equal(base.length, scaled.length);
  for (let i = 0; i < base.length; i++) {
    assert.equal(scaled[i].range, base[i].range * 3);
    assert.equal(scaled[i].mean2, base[i].mean2 * 3);
    assert.equal(scaled[i].weight, base[i].weight);
  }
});

test("预处理保留原始采样编号且严格反转", () => {
  const { pre } = run([0, 0, 3, 3, 1, 4, 4, 0]);
  assert.deepEqual(
    pre.turningPoints.map((t) => [t.origIndex, t.value]),
    [
      [0, 0],
      [2, 3],
      [4, 1],
      [5, 4],
      [7, 0],
    ]
  );
});
