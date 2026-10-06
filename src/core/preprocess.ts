import { PreprocessResult, TurningPoint } from "./types";

export const PLATFORM_RULE =
  "dedupe-consecutive-v1: 先去掉连续相等值，再保留两端及严格方向反转点（峰谷）";

export function preprocess(values: number[]): PreprocessResult {
  const deduped: { origIndex: number; value: number }[] = [];
  for (let i = 0; i < values.length; i++) {
    if (deduped.length === 0 || deduped[deduped.length - 1].value !== values[i]) {
      deduped.push({ origIndex: i, value: values[i] });
    }
  }
  const turningPoints: TurningPoint[] = [];
  const n = deduped.length;
  for (let i = 0; i < n; i++) {
    const keep =
      i === 0 ||
      i === n - 1 ||
      (deduped[i].value - deduped[i - 1].value) *
        (deduped[i + 1].value - deduped[i].value) <
        0;
    if (keep) {
      turningPoints.push({
        tpIndex: turningPoints.length,
        origIndex: deduped[i].origIndex,
        value: deduped[i].value,
      });
    }
  }
  return { deduped, turningPoints };
}
