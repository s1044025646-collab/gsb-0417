import * as http from "node:http";
import { AddressInfo } from "node:net";
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
import { extractTurningPoints, validateSeries, ValidationError } from "./rainflow";

const MAX_BODY = 8 * 1024 * 1024;
const MAX_EXPLAIN = 200;

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(json);
}

function sendError(res: http.ServerResponse, status: number, code: string, message: string): void {
  send(res, status, { error: { code, message } });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new ValidationError("E_BODY_TOO_LARGE", "请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseId(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map((c) => esc(r[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}

export function createServer(): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true });
      }

      // POST /series  { name, values, revisionOf? }
      if (method === "POST" && url.pathname === "/series") {
        const body = JSON.parse(await readBody(req));
        const values = validateSeries(body.values);
        const name = typeof body.name === "string" && body.name ? body.name : "unnamed";
        const revisionOf =
          body.revisionOf === undefined ? undefined : Number(body.revisionOf);
        if (revisionOf !== undefined && !Number.isSafeInteger(revisionOf)) {
          return sendError(res, 400, "E_BAD_REVISION", "revisionOf 必须是整数");
        }
        const series = createSeries(name, values, revisionOf);
        return send(res, 201, { series });
      }

      if (method === "GET" && url.pathname === "/series") {
        return send(res, 200, { series: listSeries() });
      }

      if (parts[0] === "series" && parts.length >= 2) {
        const id = parseId(parts[1]);
        if (id === null) return sendError(res, 400, "E_BAD_ID", "序列 id 非法");
        const series = getSeries(id);
        if (!series) return sendError(res, 404, "E_NOT_FOUND", "序列不存在");

        if (method === "GET" && parts.length === 2) {
          return send(res, 200, { series, values: getSamples(id) });
        }
        if (method === "GET" && parts[2] === "turning-points") {
          return send(res, 200, { turningPoints: extractTurningPoints(getSamples(id)) });
        }
        if (method === "POST" && parts[2] === "count") {
          const { reportId, result } = runCount(id);
          return send(res, 201, {
            reportId,
            totalHalfCount: result.totalHalfCount,
            cycleCount: result.cycles.length,
          });
        }
        if (method === "GET" && parts[2] === "reports") {
          return send(res, 200, { reports: listReports(id) });
        }
      }

      // GET /compare?a=1&b=2  比较两个序列版本
      if (method === "GET" && url.pathname === "/compare") {
        const a = parseId(url.searchParams.get("a") ?? undefined);
        const b = parseId(url.searchParams.get("b") ?? undefined);
        if (a === null || b === null) {
          return sendError(res, 400, "E_BAD_ID", "需要整数参数 a 与 b");
        }
        const va = getSamples(a);
        const vb = getSamples(b);
        if (!getSeries(a) || !getSeries(b)) {
          return sendError(res, 404, "E_NOT_FOUND", "序列不存在");
        }
        const diffs: { seq: number; a: number | null; b: number | null }[] = [];
        const n = Math.max(va.length, vb.length);
        for (let i = 0; i < n; i++) {
          const x = i < va.length ? va[i] : null;
          const y = i < vb.length ? vb[i] : null;
          if (x !== y) diffs.push({ seq: i, a: x, b: y });
        }
        return send(res, 200, {
          lengthA: va.length,
          lengthB: vb.length,
          diffCount: diffs.length,
          diffs: diffs.slice(0, MAX_EXPLAIN),
          truncated: diffs.length > MAX_EXPLAIN,
        });
      }

      if (parts[0] === "reports" && parts.length >= 2) {
        const id = parseId(parts[1]);
        if (id === null) return sendError(res, 400, "E_BAD_ID", "报告 id 非法");
        const report = getReport(id);
        if (!report) return sendError(res, 404, "E_NOT_FOUND", "报告不存在");

        if (method === "GET" && parts.length === 2) {
          return send(res, 200, report);
        }
        if (method === "GET" && parts[2] === "stack") {
          const limit = Math.min(
            Number(url.searchParams.get("limit") ?? MAX_EXPLAIN) || MAX_EXPLAIN,
            MAX_EXPLAIN
          );
          const offset = Number(url.searchParams.get("offset") ?? 0) || 0;
          return send(res, 200, { events: getStackEvents(id, limit, offset), limit, offset });
        }
        if (method === "GET" && parts[2] === "export") {
          const format = url.searchParams.get("format") ?? "json";
          const section = url.searchParams.get("section") ?? "cycles";
          const rows =
            section === "spectrum"
              ? (report.spectrum as Record<string, unknown>[])
              : (report.cycles as Record<string, unknown>[]);
          if (format === "csv") {
            res.writeHead(200, { "content-type": "text/csv; charset=utf-8" });
            return res.end(toCsv(rows));
          }
          return send(res, 200, { section, rows });
        }
      }

      sendError(res, 404, "E_NO_ROUTE", "路由不存在");
    } catch (e) {
      if (e instanceof ValidationError) {
        return sendError(res, 400, e.code, e.message);
      }
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith("E_NOT_FOUND")) {
        return sendError(res, 404, "E_NOT_FOUND", msg);
      }
      sendError(res, 500, "E_INTERNAL", msg);
    }
  });
}

/** 从指定端口起寻找空闲端口并监听，返回实际端口。 */
export function listen(server: http.Server, preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (port: number, attempts: number) => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && attempts > 0) tryPort(port + 1, attempts - 1);
        else reject(err);
      });
      server.listen(port, () => {
        resolve((server.address() as AddressInfo).port);
      });
    };
    tryPort(preferred, 20);
  });
}
