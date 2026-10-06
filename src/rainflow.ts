/**
 * 雨流循环计数核心：转折点提取 + 三点栈算法。
 * 计数单位使用“半循环”整数：1 = 半次，2 = 一次。
 * 均值用 mean2 = 2 * mean 的整数保存，避免浮点聚合误差。
 */

export const ALGORITHM_VERSION = "rf-stack-1.0";
export const PLATFORM_RULE = "dedupe-consecutive+strict-reversal-endpoints";

export const MAX_POINTS = 100000;
export const MAX_ABS_VALUE = 1e12;

export interface TurningPoint {
  /** 原始采样序号（0 起） */
  seq: number;
  value: number;
}

export interface CycleRecord {
  /** 来源转折点在转折点数组中的下标 */
  tpIndex1: number;
  tpIndex2: number;
  /** 来源转折点的原始采样序号 */
  seq1: number;
  seq2: number;
  value1: number;
  value2: number;
  range: number;
  /** 两倍均值（整数） */
  mean2: number;
  /** 1 = 半循环，2 = 完整循环 */
  weight: 1 | 2;
  /** 触发本次结算的新转折点下标；残余段结算为 -1 */
  triggeredBy: number;
  kind: "half" | "full" | "residual";
}

export interface StackEvent {
  step: number;
  action: "push" | "close-half" | "close-full" | "residual";
  stack: number[];
  note: string;
}

export interface SpectrumBin {
  range: number;
  mean2: number;
  /** 半循环单位计数总和 */
  halfCount: number;
}

export interface CountResult {
  turningPoints: TurningPoint[];
  cycles: CycleRecord[];
  spectrum: SpectrumBin[];
  events: StackEvent[];
  /** 半循环单位总计数 */
  totalHalfCount: number;
}

export class ValidationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function validateSeries(values: unknown): number[] {
  if (!Array.isArray(values)) {
    throw new ValidationError("E_NOT_ARRAY", "载荷必须是整数数组");
  }
  if (values.length > MAX_POINTS) {
    throw new ValidationError("E_TOO_LONG", `采样点数超过上限 ${MAX_POINTS}`);
  }
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (typeof v !== "number" || !Number.isSafeInteger(v)) {
      throw new ValidationError("E_BAD_VALUE", `第 ${i} 个采样不是安全整数`);
    }
    if (Math.abs(v) > MAX_ABS_VALUE) {
      throw new ValidationError("E_OUT_OF_RANGE", `第 ${i} 个采样超出允许范围`);
    }
    out.push(v);
  }
  return out;
}

/**
 * 转折点提取：先去连续相等值，再保留两端与严格方向反转点。
 * 保留原始采样序号。
 */
export function extractTurningPoints(values: number[]): TurningPoint[] {
  if (values.length === 0) return [];
  const dedup: TurningPoint[] = [];
  for (let i = 0; i < values.length; i++) {
    if (dedup.length === 0 || dedup[dedup.length - 1].value !== values[i]) {
      dedup.push({ seq: i, value: values[i] });
    }
  }
  if (dedup.length <= 2) return dedup.slice();
  const out: TurningPoint[] = [dedup[0]];
  for (let i = 1; i < dedup.length - 1; i++) {
    const prev = dedup[i - 1].value;
    const cur = dedup[i].value;
    const next = dedup[i + 1].value;
    if (cur - prev !== 0 && next - cur !== 0 && (cur - prev > 0) !== (next - cur > 0)) {
      out.push(dedup[i]);
    }
  }
  out.push(dedup[dedup.length - 1]);
  return out;
}

/**
 * 三点栈雨流计数。
 * 每个新转折点入栈后，比较末三点的前段范围 X 与后段范围 Y：
 * X > Y 不闭合；X <= Y 结算前段。栈恰三点出半循环并移除最早点；
 * 多于三点出完整循环并移除该段两端点，继续检查。
 * 全部点处理完后，栈中剩余相邻段各结算为半循环。
 */
export function countCycles(values: number[]): CountResult {
  const tps = extractTurningPoints(values);
  const cycles: CycleRecord[] = [];
  const events: StackEvent[] = [];
  let step = 0;

  const stack: number[] = [];
  const snapshot = () => stack.slice();

  for (let i = 0; i < tps.length; i++) {
    stack.push(i);
    events.push({
      step: step++,
      action: "push",
      stack: snapshot(),
      note: `入栈转折点 #${i} (seq=${tps[i].seq}, value=${tps[i].value})`,
    });
    while (stack.length >= 3) {
      const n = stack.length;
      const a = tps[stack[n - 3]];
      const b = tps[stack[n - 2]];
      const c = tps[stack[n - 1]];
      const x = Math.abs(b.value - a.value);
      const y = Math.abs(c.value - b.value);
      if (x > y) break;
      if (n === 3) {
        cycles.push(makeCycle(tps, stack[0], stack[1], 1, i, "half"));
        events.push({
          step: step++,
          action: "close-half",
          stack: snapshot(),
          note: `X=${x} <= Y=${y}，栈恰三点，结算半循环 [${a.value} -> ${b.value}]，移除最早点`,
        });
        stack.shift();
      } else {
        cycles.push(makeCycle(tps, stack[n - 3], stack[n - 2], 2, i, "full"));
        events.push({
          step: step++,
          action: "close-full",
          stack: snapshot(),
          note: `X=${x} <= Y=${y}，栈多于三点，结算完整循环 [${a.value} -> ${b.value}]，移除两端点`,
        });
        stack.splice(n - 3, 2);
      }
    }
  }

  for (let k = 0; k + 1 < stack.length; k++) {
    cycles.push(makeCycle(tps, stack[k], stack[k + 1], 1, -1, "residual"));
    events.push({
      step: step++,
      action: "residual",
      stack: snapshot(),
      note: `残余段结算半循环 [${tps[stack[k]].value} -> ${tps[stack[k + 1]].value}]`,
    });
  }

  const spectrumMap = new Map<string, SpectrumBin>();
  let totalHalfCount = 0;
  for (const c of cycles) {
    totalHalfCount += c.weight;
    const key = `${c.range}:${c.mean2}`;
    const bin = spectrumMap.get(key);
    if (bin) bin.halfCount += c.weight;
    else spectrumMap.set(key, { range: c.range, mean2: c.mean2, halfCount: c.weight });
  }
  const spectrum = [...spectrumMap.values()].sort(
    (p, q) => p.range - q.range || p.mean2 - q.mean2
  );

  return { turningPoints: tps, cycles, spectrum, events, totalHalfCount };
}

function makeCycle(
  tps: TurningPoint[],
  i1: number,
  i2: number,
  weight: 1 | 2,
  triggeredBy: number,
  kind: CycleRecord["kind"]
): CycleRecord {
  const p1 = tps[i1];
  const p2 = tps[i2];
  return {
    tpIndex1: i1,
    tpIndex2: i2,
    seq1: p1.seq,
    seq2: p2.seq,
    value1: p1.value,
    value2: p2.value,
    range: Math.abs(p2.value - p1.value),
    mean2: p1.value + p2.value,
    weight,
    triggeredBy,
    kind,
  };
}
