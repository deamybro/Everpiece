import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AutomateService, Result } from "./service.ts";
import { log } from "./log.ts";

const MAX_BODY = 16_384;

function send(res: ServerResponse, out: Result, origin?: string): void {
  res.writeHead(out.httpStatus, {
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff",
    ...(origin ? { "access-control-allow-origin": origin, vary: "origin" } : {}),
  });
  res.end(JSON.stringify(out.body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw Object.assign(new Error(), { status: 415, code: "UnsupportedMediaType" });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error(), { status: 413, code: "PayloadTooLarge" });
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error(), { status: 400, code: "MalformedJson" });
  }
}

export function createAutomateServer(svc: AutomateService): Server {
  const origin = svc.cfg.allowedOrigin;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    try {
      if (req.method === "OPTIONS" && origin) {
        res.writeHead(204, { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type", "access-control-max-age": "600" });
        return void res.end();
      }
      if (req.method === "GET" && p === "/healthz") return send(res, { httpStatus: 200, body: svc.health() }, origin);
      // trigger intake: internal only (the indexer watcher), authenticated by a shared key, never from a browser
      if (req.method === "POST" && p === "/v1/automate/triggers") {
        const key = req.headers["x-automate-key"];
        if (!svc.authorizedInternal(Array.isArray(key) ? key[0] : key)) return send(res, { httpStatus: 401, body: { error: "Unauthorized" } });
        return send(res, await svc.trigger(await readJson(req)));
      }
      const ip = process.env.TRUST_PROXY === "1" ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || "unknown" : req.socket.remoteAddress ?? "unknown";
      const limited = svc.limited(ip, req.method === "GET");
      if (limited) return send(res, limited, origin);
      let m: RegExpExecArray | null;
      if (req.method === "POST" && p === "/v1/automate/rules") return send(res, await svc.putRule(await readJson(req)), origin);
      if (req.method === "GET" && (m = /^\/v1\/automate\/rules\/(0x[0-9a-fA-F]{40})$/.exec(p))) return send(res, svc.rules(m[1]), origin);
      if (req.method === "GET" && (m = /^\/v1\/automate\/executions\/by-owner\/(0x[0-9a-fA-F]{40})$/.exec(p))) return send(res, svc.executions(m[1]), origin);
      if (req.method === "GET" && (m = /^\/v1\/automate\/executions\/(0x[0-9a-fA-F]{64})$/.exec(p))) return send(res, svc.execution(m[1]), origin);
      if (req.method === "POST" && p === "/v1/automate/legs") return send(res, await svc.reportLeg(await readJson(req)), origin);
      return send(res, { httpStatus: 404, body: { error: "NotFound" } }, origin);
    } catch (e) {
      const x = e as { status?: number; code?: string };
      if (x.status && x.code) return send(res, { httpStatus: x.status, body: { error: x.code } }, origin);
      log("error", "http.unhandled", { err: String(e).slice(0, 200) });
      if (!res.headersSent) return send(res, { httpStatus: 500, body: { error: "InternalError" } }, origin);
      res.destroy();
    }
  });
  server.on("clientError", (_e, socket) => socket.destroy());
  return server;
}
