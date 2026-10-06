import * as fs from "node:fs";
import {
  createSeries,
  getReport,
  getSamples,
  getSeries,
  getStackEvents,
  listReports,
  listSeries,
  runCount,
} from "./db";
import { createServer, listen, toCsv } from "./api";
import { countCycles, extractTurningPoints, validateSeries } from "./rainflow";

const DEFAULT_PORT = Number(process.env.PORT ?? 8734);

function fail(msg: string): never {
  console.error(`错误: ${msg}`);
  process.exit(1);
}

function readValues(args: string[]): number[] {
  const jsonIdx = args.indexOf("--values");
  const fileIdx = args.indexOf("--file");
  let raw: unknown;
  if (jsonIdx >= 0) {
    raw = JSON.parse(args[jsonIdx + 1]);
  } else if (fileIdx >= 0) {
    raw = JSON.parse(fs.readFileSync(args[fileIdx + 1], "utf8"));
  } else {
    fail("需要 --values '[1,2,3]' 或 --file path.json");
  }
  return validateSeries(raw);
}

function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function printReport(reportId: number): void {
  const r = getReport(reportId);
  if (!r) fail(`报告 ${reportId} 不存在`);
  const meta = r.report as unknown as Record<string, unknown>;
  console.log(`报告 #${meta.id}  序列 #${meta.series_id}  算法 ${meta.algorithm_version}`);
  console.log(`平台规则: ${meta.platform_rule}  总半循环计数: ${meta.total_half_count}`);
  console.log("转折点:");
  for (const tp of r.turningPoints as unknown as { tpIndex: number; seq: number; value: number }[]) {
    console.log(`  #${tp.tpIndex}  seq=${tp.seq}  value=${tp.value}`);
  }
  console.log("循环明细:");
  for (const c of r.cycles as unknown as Record<string, number | string>[]) {
    console.log(
      `  [${c.idx}] ${c.kind}  ${c.value1} -> ${c.value2}  range=${c.range}  mean=${Number(c.mean2) / 2}  weight=${c.weight}  触发点=${c.triggeredBy}  来源seq=${c.seq1},${c.seq2}`
    );
  }
  console.log("循环谱 (range, mean, 半循环计数):");
  for (const s of r.spectrum as unknown as { range: number; mean2: number; halfCount: number }[]) {
    console.log(`  range=${s.range}  mean=${s.mean2 / 2}  halfCount=${s.halfCount}`);
  }
}

function demo(): void {
  const cases: { name: string; values: number[] }[] = [
    { name: "demo-main", values: [0, 3, 1, 4, 0] },
    { name: "demo-monotonic", values: [0, 1, 2, 3, 4] },
    { name: "demo-plateau", values: [0, 2, 2, 2, 0, 2, 0] },
  ];
  for (const c of cases) {
    console.log(`\n=== ${c.name}: [${c.values.join(", ")}] ===`);
    const result = countCycles(c.values);
    console.log(`转折点: ${result.turningPoints.map((t) => `${t.value}@seq${t.seq}`).join("  ")}`);
    for (const e of result.events) {
      console.log(`  step${e.step} [${e.action}] 栈=[${e.stack.join(",")}] ${e.note}`);
    }
    console.log("循环明细:");
    for (const cy of result.cycles) {
      console.log(
        `  ${cy.kind}  ${cy.value1} -> ${cy.value2}  range=${cy.range}  mean=${cy.mean2 / 2}  weight=${cy.weight}`
      );
    }
    console.log("循环谱:");
    for (const s of result.spectrum) {
      console.log(`  range=${s.range}  mean=${s.mean2 / 2}  halfCount=${s.halfCount}`);
    }
  }
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "serve": {
      const port = Number(opt(args, "--port") ?? DEFAULT_PORT);
      const server = createServer();
      const actual = await listen(server, port);
      console.log(`雨流计数 API 已启动: http://127.0.0.1:${actual}`);
      break;
    }
    case "import": {
      const values = readValues(args);
      const name = opt(args, "--name") ?? "unnamed";
      const revOf = opt(args, "--revision-of");
      const series = createSeries(name, values, revOf ? Number(revOf) : undefined);
      console.log(`已导入序列 #${series.id} (revision ${series.revision}, 长度 ${series.length})`);
      break;
    }
    case "list": {
      for (const s of listSeries()) {
        console.log(`#${s.id}  ${s.name}  rev=${s.revision}  len=${s.length}  ${s.created_at}`);
      }
      break;
    }
    case "turning-points": {
      const id = Number(args[0]);
      if (!getSeries(id)) fail(`序列 ${id} 不存在`);
      const tps = extractTurningPoints(getSamples(id));
      for (const tp of tps) console.log(`seq=${tp.seq}  value=${tp.value}`);
      break;
    }
    case "count": {
      const id = Number(args[0]);
      const { reportId, result } = runCount(id);
      console.log(`生成报告 #${reportId}，循环 ${result.cycles.length} 条，总半循环计数 ${result.totalHalfCount}`);
      printReport(reportId);
      break;
    }
    case "report": {
      printReport(Number(args[0]));
      break;
    }
    case "stack": {
      const id = Number(args[0]);
      const events = getStackEvents(id, 500, 0);
      for (const e of events) console.log(`step${e.step} [${e.action}] 栈=[${e.stack.join(",")}] ${e.note}`);
      break;
    }
    case "reports": {
      const id = args[0] ? Number(args[0]) : undefined;
      for (const r of listReports(id) as unknown as Record<string, unknown>[]) {
        console.log(`报告 #${r.id}  序列 #${r.series_id}  ${r.status}  halfCount=${r.total_half_count}  ${r.created_at}`);
      }
      break;
    }
    case "compare": {
      const a = Number(args[0]);
      const b = Number(args[1]);
      const va = getSamples(a);
      const vb = getSamples(b);
      if (!getSeries(a) || !getSeries(b)) fail("序列不存在");
      const n = Math.max(va.length, vb.length);
      let diffs = 0;
      for (let i = 0; i < n; i++) {
        if (va[i] !== vb[i]) {
          diffs++;
          console.log(`seq=${i}  A=${va[i] ?? "-"}  B=${vb[i] ?? "-"}`);
        }
      }
      console.log(`长度 A=${va.length} B=${vb.length}，差异 ${diffs} 处`);
      break;
    }
    case "export": {
      const id = Number(args[0]);
      const format = opt(args, "--format") ?? "csv";
      const section = opt(args, "--section") ?? "cycles";
      const r = getReport(id);
      if (!r) fail(`报告 ${id} 不存在`);
      const rows = (section === "spectrum" ? r.spectrum : r.cycles) as Record<string, unknown>[];
      if (format === "json") console.log(JSON.stringify(rows, null, 2));
      else process.stdout.write(toCsv(rows));
      break;
    }
    case "demo": {
      demo();
      break;
    }
    default:
      console.log(`用法: node dist/cli.js <命令>
  serve [--port N]                 启动 API 服务（默认自动选空闲端口）
  import --name N --values '[..]'  导入载荷序列（--file 从文件读，--revision-of 修订）
  list                             列出序列
  turning-points <seriesId>        查看转折点
  count <seriesId>                 执行雨流计数并生成报告
  report <reportId>                查看报告明细与循环谱
  stack <reportId>                 查看栈变化过程
  reports [seriesId]               列出报告
  compare <idA> <idB>              比较两个序列版本
  export <reportId> [--format csv|json] [--section cycles|spectrum]
  demo                             运行内置演示序列`);
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
