import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Method } from "./config.ts";
import { publicView, type Relayer } from "./relayer.ts";
import { log } from "./log.ts";

/** Route table: the ONLY actions this service relays (no generic "relay calldata" endpoint exists). */
const ROUTES: Record<string, Method> = {
  "/v1/payments/create": "createPayment",
  "/v1/payments/claim-username": "claimUsernamePayment",
  "/v1/payments/claim-link": "claimLinkPayment",
  "/v1/payments/cancel": "cancel",
  "/v1/payments/refund": "refundExpired",
  "/v1/pay/ausd": "payWithAusd",
  "/v1/pay/token": "payWithToken",
};

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function send(res: ServerResponse, status: number, body: unknown, origin?: string): void {
  const json = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store", // never cache claim/approval-bearing responses (master §2.6)
    "x-content-type-options": "nosniff",
    ...(origin ? { "access-control-allow-origin": origin, vary: "origin" } : {}),
  });
  res.end(json);
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const ct = req.headers["content-type"] ?? "";
  if (!/^application\/json\b/i.test(ct)) throw new HttpError(415, "UnsupportedMediaType");
  const declared = Number(req.headers["content-length"] ?? "0");
  if (declared > maxBytes) throw new HttpError(413, "PayloadTooLarge");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new HttpError(413, "PayloadTooLarge");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "MalformedJson");
  }
}

function clientIp(req: IncomingMessage): string {
  // Trust X-Forwarded-For only behind a known proxy; the default is the socket address.
  return process.env.TRUST_PROXY === "1" ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || "unknown" : req.socket.remoteAddress ?? "unknown";
}

export function createHttpServer(relayer: Relayer): Server {
  const origin = relayer.cfg.allowedOrigin;
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "OPTIONS" && origin) {
        res.writeHead(204, {
          "access-control-allow-origin": origin,
          "access-control-allow-methods": "GET, POST",
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "600",
        });
        return res.end();
      }
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, await relayer.health(), origin);
      const m = /^\/v1\/requests\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (req.method === "GET" && m) {
        const row = relayer.getRequest(m[1]);
        return row ? send(res, 200, publicView(row), origin) : send(res, 404, { error: "NotFound" }, origin);
      }
      if (url.pathname.startsWith("/v1/funding/")) {
        const f = relayer.funding;
        if (!f) return send(res, 503, { error: "FUNDING_UNAVAILABLE" }, origin);
        const ip = clientIp(req);
        let out;
        if (req.method === "GET" && url.pathname === "/v1/funding/sources") out = await f.sources(ip);
        else if (req.method === "GET" && url.pathname === "/v1/funding/status") out = await f.status(url.searchParams.get("depositAddress") ?? "", ip);
        else if (req.method === "POST" && url.pathname === "/v1/funding/quote") out = await f.quote(await readJson(req, relayer.cfg.maxBodyBytes), ip);
        else if (req.method === "POST" && url.pathname === "/v1/funding/deposit") out = await f.deposit(await readJson(req, relayer.cfg.maxBodyBytes), ip);
        else return send(res, 404, { error: "NotFound" }, origin);
        return send(res, out.httpStatus, out.body, origin);
      }
      if (url.pathname === "/v1/quotes") {
        if (req.method !== "POST") return send(res, 405, { error: "MethodNotAllowed" }, origin);
        const out = await relayer.quote(await readJson(req, relayer.cfg.maxBodyBytes), clientIp(req));
        return send(res, out.httpStatus, out.body, origin);
      }
      const method = ROUTES[url.pathname];
      if (!method) return send(res, 404, { error: "NotFound" }, origin);
      if (req.method !== "POST") return send(res, 405, { error: "MethodNotAllowed" }, origin);
      const body = await readJson(req, relayer.cfg.maxBodyBytes);
      const out = await relayer.submitAction(method, body, clientIp(req));
      return send(res, out.httpStatus, out.body, origin);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.code }, origin);
      log("error", "http.unhandled", { path: url.pathname, err: String(e) });
      return send(res, 500, { error: "InternalError" }, origin);
    }
  });
}
