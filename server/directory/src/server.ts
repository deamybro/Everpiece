import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { DirectoryService, Result } from "./directory.ts";
import { log } from "./log.ts";

const ROUTES: Record<string, (s: DirectoryService, body: unknown, ip: string) => Promise<Result>> = {
  "/v1/usernames/register": (s, b, ip) => s.register(b, ip),
  "/v1/usernames/available": (s, b, ip) => s.available(b, ip),
  "/v1/usernames/lookup": (s, b, ip) => s.lookup(b, ip),
  "/v1/usernames/by-account": (s, b, ip) => s.byAccount(b, ip),
  "/v1/message-keys/register": (s, b, ip) => s.registerMessageKey(b, ip),
  "/v1/inbox/deliver": (s, b, ip) => s.deliver(b, ip),
  "/v1/inbox/list": (s, b, ip) => s.inbox(b, ip),
};

function send(res: ServerResponse, status: number, body: unknown, origin?: string): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store", // inbox reads and lookups must never be cached (pinning relies on fresh answers)
    "x-content-type-options": "nosniff",
    ...(origin ? { "access-control-allow-origin": origin, vary: "origin" } : {}),
  });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, max: number): Promise<unknown> {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw Object.assign(new Error(), { status: 415, code: "UnsupportedMediaType" });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw Object.assign(new Error(), { status: 413, code: "PayloadTooLarge" });
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error(), { status: 400, code: "MalformedJson" });
  }
}

export function createDirectoryServer(svc: DirectoryService): Server {
  const origin = svc.cfg.allowedOrigin;
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "OPTIONS" && origin) {
        res.writeHead(204, { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type" });
        return res.end();
      }
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, svc.health(), origin);
      const route = ROUTES[url.pathname];
      if (!route) return send(res, 404, { error: "NotFound" }, origin);
      if (req.method !== "POST") return send(res, 405, { error: "MethodNotAllowed" }, origin);
      const ip = process.env.TRUST_PROXY === "1" ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || "unknown" : req.socket.remoteAddress ?? "unknown";
      const out = await route(svc, await readJson(req, svc.cfg.maxBodyBytes), ip);
      return send(res, out.httpStatus, out.body, origin);
    } catch (e) {
      const x = e as { status?: number; code?: string };
      if (x.status && x.code) return send(res, x.status, { error: x.code }, origin);
      log("error", "http.unhandled", { path: url.pathname, err: String(e) });
      return send(res, 500, { error: "InternalError" }, origin);
    }
  });
}
