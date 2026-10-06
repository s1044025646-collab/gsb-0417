import { RainflowService } from "./service";

export function runDemo(service: RainflowService) {
  const show = (title: string, values: number[]) => {
    const seq = service.importSequence(`demo-${title}`, values);
    const result = service.runCount(seq.id);
    const cycles = service.getCycles(result.reportId, 100).cycles;
    console.log(`\n=== ${title}: [${values.join(", ")}] ===`);
    console.log(`序列 #${seq.id}，报告 #${result.reportId}`);
    for (const c of cycles as any[]) {
      console.log(
        `  #${c.order} ${c.weight === 2 ? "全循环" : "半循环"} ${c.fromValue}->${c.toValue}` +
        ` 范围=${c.range} 均值=${c.mean2 / 2} 来源采样=${c.fromOrig},${c.toOrig}` +
        ` 触发=${c.triggeredByOrig}${c.residual ? " (残余)" : ""}`
      );
    }
    console.log("  循环谱(范围, 均值, 半循环单位):");
    for (const s of result.spectrum as any[]) {
      console.log(`    范围=${s.range} 均值=${s.mean2 / 2} 计数=${s.halfUnits / 2}`);
    }
  };

  show("主演示", [0, 3, 1, 4, 0]);
  show("单调序列", [1, 2, 3, 4, 5]);
  show("重复平台", [0, 2, 2, 2, 0, 0, 3, 3, 0]);
}
