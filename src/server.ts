import * as http from "node:http";
import { RainflowService } from "./service";
import { ApiError, MAX_DISPLAY } from "./errors";

function parsePaging(url: URL) {
  const limit = Math.min(Number(url.searchParams.get("limit")) || MAX_DISPLAY, MAX_DISPLAY);
  const offset = Number(url.searchParams.get("offset")) || 0;
  return { limit, offset };
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError("INVALID_INPUT", "请求体不是合法 JSON");
  }
}

export function createServer(service: RainflowService) {
  return http.createServer(async (req, res) => {
    const send = (status: number, data: unknown, contentType = "application/json; charset=utf-8") => {
      const body = contentType.startsWith("application/json") ? JSON.stringify(data) : String(data);
      res.writeHead(status, { "Content-Type": contentType });
      res.end(body);
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/api/health") {
        return send(200, { ok: true });
      }
      if (method === "POST" && url.pathname === "/api/sequences") {
        const body = (await readBody(req)) as { name?: string; values?: unknown };
        return send(201, service.importSequence(body.name ?? "", body.values));
      }
      if (method === "GET" && url.pathname === "/api/sequences") {
        return send(200, service.listSequences());
      }
      if (parts[0] === "api" && parts[1] === "sequences" && parts[2]) {
        const seqId = Number(parts[2]);
        if (!Number.isSafeInteger(seqId)) throw new ApiError("INVALID_INPUT", "序列 id 非法");
        if (method === "GET" && parts.length === 3) {
          const { limit, offset } = parsePaging(url);
          return send(200, service.getSequence(seqId, limit, offset));
        }
        if (method === "GET" && parts[3] === "turning-points") {
          const { limit, offset } = parsePaging(url);
          return send(200, service.getTurningPoints(seqId, limit, offset));
        }
        if (method === "POST" && parts[3] === "count") {
          return send(201, service.runCount(seqId));
        }
        if (method === "POST" && parts[3] === "revisions") {
          const body = (await readBody(req)) as { name?: string; values?: unknown };
          return send(201, service.importSequence(body.name ?? "", body.values, seqId));
        }
        if (method === "GET" && parts[3] === "compare") {
          const other = Number(url.searchParams.get("other"));
          if (!Number.isSafeInteger(other)) throw new ApiError("INVALID_INPUT", "缺少 ?other=<seqId>");
          return send(200, service.compareSequences(seqId, other));
        }
      }
      if (parts[0] === "api" && parts[1] === "reports" && parts[2]) {
        const reportId = Number(parts[2]);
        if (!Number.isSafeInteger(reportId)) throw new ApiError("INVALID_INPUT", "报告 id 非法");
        if (method === "GET" && parts.length === 3) return send(200, service.getReport(reportId));
        if (method === "GET" && parts[3] === "cycles") {
          const { limit, offset } = parsePaging(url);
          return send(200, service.getCycles(reportId, limit, offset));
        }
        if (method === "GET" && parts[3] === "stack") {
          const { limit, offset } = parsePaging(url);
          return send(200, service.getStackEvents(reportId, limit, offset));
        }
        if (method === "GET" && parts[3] === "export") {
          const format = url.searchParams.get("format") === "csv" ? "csv" : "json";
          const out = service.exportReport(reportId, format);
          return send(200, out.body, out.contentType + (out.contentType === "text/csv" ? "; charset=utf-8" : ""));
        }
      }
      throw new ApiError("NOT_FOUND", `路由不存在: ${method} ${url.pathname}`, 404);
    } catch (e) {
      if (e instanceof ApiError) {
        return send(e.httpStatus, { error: { code: e.code, message: e.message } });
      }
      send(500, { error: { code: "INTERNAL", message: String(e) } });
    }
  });
}

export function startServer(service: RainflowService, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer(service);
    server.on("error", reject);
    server.listen(port, () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      console.log(`雨流计数 API 已启动: http://127.0.0.1:${actual}`);
      resolve(actual);
    });
  });
}
