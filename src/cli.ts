import { openDb, defaultDbPath } from "./db";
import { RainflowService } from "./service";
import { startServer } from "./server";
import { runDemo } from "./demo";

function parseArgs(argv: string[]) {
  const args: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        opts[key] = next;
        i++;
      } else {
        opts[key] = "true";
      }
    } else {
      args.push(argv[i]);
    }
  }
  return { args, opts };
}

const USAGE = `雨流载荷循环计数 CLI
用法: node dist/src/cli.js <命令> [参数] [--db 路径]
命令:
  serve [--port N]            启动 API 服务（默认端口 0 = 自动选空闲端口）
  import <name> <v1,v2,...>   导入载荷序列（整数，逗号分隔）
  revise <seqId> <name> <v1,v2,...>  基于已有序列创建修订版
  list                        列出全部序列
  show <seqId> [--limit N]    查看采样
  turning-points <seqId>      查看转折点
  count <seqId>               执行雨流计数并生成报告
  report <reportId>           查看报告与循环谱
  cycles <reportId>           查看逐循环明细
  stack <reportId>            查看栈变化过程
  compare <seqIdA> <seqIdB>   比较两个序列版本
  export <reportId> [--format csv|json] [--out 文件]
  demo                        运行内置演示（0,3,1,4,0 等）
`;

async function main() {
  const { args, opts } = parseArgs(process.argv.slice(2));
  const cmd = args[0];
  if (!cmd || cmd === "help") {
    console.log(USAGE);
    return;
  }
  const db = openDb(opts.db ?? defaultDbPath());
  const service = new RainflowService(db);
  const print = (x: unknown) => console.log(JSON.stringify(x, null, 2));
  const limit = opts.limit ? Number(opts.limit) : undefined;

  switch (cmd) {
    case "serve": {
      const port = opts.port !== undefined ? Number(opts.port) : 0;
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error("--port 必须是 0-65535 的整数");
      }
      await startServer(service, port);
      return;
    }
    case "import": {
      const [, name, csv] = args;
      print(service.importSequence(name, parseCsv(csv)));
      break;
    }
    case "revise": {
      const [, seqId, name, csv] = args;
      print(service.importSequence(name, parseCsv(csv), Number(seqId)));
      break;
    }
    case "list":
      print(service.listSequences());
      break;
    case "show":
      print(service.getSequence(Number(args[1]), limit));
      break;
    case "turning-points":
      print(service.getTurningPoints(Number(args[1]), limit));
      break;
    case "count":
      print(service.runCount(Number(args[1])));
      break;
    case "report":
      print(service.getReport(Number(args[1])));
      break;
    case "cycles":
      print(service.getCycles(Number(args[1]), limit));
      break;
    case "stack":
      print(service.getStackEvents(Number(args[1]), limit));
      break;
    case "compare":
      print(service.compareSequences(Number(args[1]), Number(args[2])));
      break;
    case "export": {
      const format = opts.format === "csv" ? "csv" : "json";
      const out = service.exportReport(Number(args[1]), format);
      if (opts.out) {
        require("node:fs").writeFileSync(opts.out, out.body);
        console.log(`已导出到 ${opts.out}`);
      } else {
        console.log(out.body);
      }
      break;
    }
    case "demo":
      runDemo(service);
      break;
    default:
      console.error(`未知命令: ${cmd}\n${USAGE}`);
      process.exitCode = 1;
  }
}

function parseCsv(csv: string | undefined): number[] {
  if (csv === undefined || csv === "") return [];
  return csv.split(",").map((s) => {
    const v = Number(s.trim());
    if (!Number.isSafeInteger(v)) throw new Error(`非法整数: ${s}`);
    return v;
  });
}

main().catch((e) => {
  console.error(`错误: ${e.code ? `[${e.code}] ` : ""}${e.message}`);
  process.exitCode = 1;
});
