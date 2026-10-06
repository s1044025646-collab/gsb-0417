export interface TurningPoint {
  tpIndex: number;
  origIndex: number;
  value: number;
}

export interface PreprocessResult {
  deduped: { origIndex: number; value: number }[];
  turningPoints: TurningPoint[];
}

export interface CycleRecord {
  order: number;
  range: number;
  mean2: number;
  weight: 1 | 2;
  fromTpIndex: number;
  toTpIndex: number;
  fromOrigIndex: number;
  toOrigIndex: number;
  fromValue: number;
  toValue: number;
  triggeredByTpIndex: number;
  triggeredByOrigIndex: number;
  residual: boolean;
}

export interface StackEvent {
  step: number;
  action: "push" | "half-cycle" | "full-cycle" | "residual-half-cycle";
  detail: string;
  stack: number[];
}

export interface RainflowResult {
  cycles: CycleRecord[];
  stackEvents: StackEvent[];
  finalStack: number[];
}

export interface SpectrumRow {
  range: number;
  mean2: number;
  halfUnits: number;
}
