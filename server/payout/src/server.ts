import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { PayoutService, Result } from "./service.ts";
import { log } from "./log.ts";

const MAX_BODY = 8_192;

function send(res: ServerResponse, out: Result, origin?: string): void {
  res.writeHead(out.httpStatus, {
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff",
    ...(origin ? { "access-control-allow-origin": origin, vary: "origin" } : {}),
  });
  res.end(JSON.stringify(out.body));
}

async function readRaw(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error(), { status: 413, code: "PayloadTooLarge" });
    chunks.push(c as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw Object.assign(new Error(), { status: 415, code: "UnsupportedMediaType" });
  try {
    return JSON.parse(Buffer.from(await readRaw(req)).toString("utf8"));
  } catch (e) {
    if ((e as { status?: number }).status) throw e;
    throw Object.assign(new Error(), { status: 400, code: "MalformedJson" });
  }
}

export function createPayoutServer(svc: PayoutService): Server {
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
      // provider webhooks: authenticated by HMAC over the raw body, never rate limited by IP
      if (req.method === "POST" && p === "/v1/payout/webhooks/paycrest") {
        const sig = req.headers["x-paycrest-signature"];
        return send(res, await svc.webhook(await readRaw(req), Array.isArray(sig) ? sig[0] : sig));
      }
      const ip = process.env.TRUST_PROXY === "1" ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || "unknown" : req.socket.remoteAddress ?? "unknown";
      const limited = svc.limited(ip, req.method === "GET");
      if (limited) return send(res, limited, origin);
      let m: RegExpExecArray | null;
      if (req.method === "GET" && p === "/v1/payout/institutions") return send(res, await svc.institutions(url.searchParams.get("currency") ?? "NGN"), origin);
      if (req.method === "POST" && p === "/v1/payout/accounts/prepare") return send(res, await svc.prepareAccount(await readJson(req), ip), origin);
      if (req.method === "POST" && p === "/v1/payout/accounts") return send(res, await svc.saveAccount(await readJson(req)), origin);
      if (req.method === "GET" && (m = /^\/v1\/payout\/accounts\/(0x[0-9a-fA-F]{40})$/.exec(p))) return send(res, await svc.account(m[1]), origin);
      if (req.method === "POST" && p === "/v1/payout/requests") return send(res, await svc.createRequest(await readJson(req)), origin);
      if (req.method === "GET" && (m = /^\/v1\/payout\/requests\/(0x[0-9a-fA-F]{64})$/.exec(p))) return send(res, await svc.getRequest(m[1]), origin);
      if (req.method === "GET" && p === "/v1/payout/rate") return send(res, await svc.rate(url.searchParams.get("amount")), origin);
      if (req.method === "POST" && p === "/v1/payout/quote") return send(res, await svc.quote(await readJson(req)), origin);
      if (req.method === "POST" && p === "/v1/payout/orders") return send(res, await svc.createOrder(await readJson(req)), origin);
      if (req.method === "GET" && (m = /^\/v1\/payout\/orders\/([A-Za-z0-9-]{8,80})$/.exec(p))) return send(res, await svc.order(m[1]), origin);
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
