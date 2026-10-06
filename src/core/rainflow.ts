import { CycleRecord, RainflowResult, SpectrumRow, StackEvent, TurningPoint } from "./types";

export const ALGO_VERSION = "rainflow-3pt-stack-v1";

export function rainflow(turningPoints: TurningPoint[]): RainflowResult {
  const cycles: CycleRecord[] = [];
  const stackEvents: StackEvent[] = [];
  const stack: TurningPoint[] = [];
  let order = 0;

  const snapshot = () => stack.map((p) => p.value);

  const emit = (
    a: TurningPoint,
    b: TurningPoint,
    weight: 1 | 2,
    trigger: TurningPoint,
    residual: boolean
  ) => {
    order += 1;
    cycles.push({
      order,
      range: Math.abs(a.value - b.value),
      mean2: a.value + b.value,
      weight,
      fromTpIndex: a.tpIndex,
      toTpIndex: b.tpIndex,
      fromOrigIndex: a.origIndex,
      toOrigIndex: b.origIndex,
      fromValue: a.value,
      toValue: b.value,
      triggeredByTpIndex: trigger.tpIndex,
      triggeredByOrigIndex: trigger.origIndex,
      residual,
    });
  };

  for (const point of turningPoints) {
    stack.push(point);
    stackEvents.push({
      step: stackEvents.length + 1,
      action: "push",
      detail: `push ${point.value} (tp#${point.tpIndex}, orig#${point.origIndex})`,
      stack: snapshot(),
    });
    while (stack.length >= 3) {
      const n = stack.length;
      const x = Math.abs(stack[n - 2].value - stack[n - 3].value);
      const y = Math.abs(stack[n - 1].value - stack[n - 2].value);
      if (x > y) break;
      if (n === 3) {
        const a = stack[0];
        const b = stack[1];
        emit(a, b, 1, point, false);
        stack.shift();
        stackEvents.push({
          step: stackEvents.length + 1,
          action: "half-cycle",
          detail: `half cycle ${a.value}->${b.value} range=${Math.abs(a.value - b.value)}`,
          stack: snapshot(),
        });
      } else {
        const a = stack[n - 3];
        const b = stack[n - 2];
        emit(a, b, 2, point, false);
        stack.splice(n - 3, 2);
        stackEvents.push({
          step: stackEvents.length + 1,
          action: "full-cycle",
          detail: `full cycle ${a.value}->${b.value} range=${Math.abs(a.value - b.value)}`,
          stack: snapshot(),
        });
      }
    }
  }

  for (let i = 0; i + 1 < stack.length; i++) {
    const a = stack[i];
    const b = stack[i + 1];
    emit(a, b, 1, b, true);
    stackEvents.push({
      step: stackEvents.length + 1,
      action: "residual-half-cycle",
      detail: `residual half cycle ${a.value}->${b.value} range=${Math.abs(a.value - b.value)}`,
      stack: stack.slice(i + 1).map((p) => p.value),
    });
  }

  return { cycles, stackEvents, finalStack: stack.map((p) => p.value) };
}

export function buildSpectrum(cycles: CycleRecord[]): SpectrumRow[] {
  const map = new Map<string, SpectrumRow>();
  for (const c of cycles) {
    const key = `${c.range}|${c.mean2}`;
    const row = map.get(key);
    if (row) {
      row.halfUnits += c.weight;
    } else {
      map.set(key, { range: c.range, mean2: c.mean2, halfUnits: c.weight });
    }
  }
  return [...map.values()].sort((a, b) => a.range - b.range || a.mean2 - b.mean2);
}
