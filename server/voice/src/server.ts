import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { MAX_UPLOAD_BYTES, type Result, type VoiceService } from "./voice.ts";
import { log } from "./log.ts";

const PATH = /^\/v1\/messages\/(0x[0-9a-fA-F]{64})(\/bind)?$/;

function send(res: ServerResponse, out: Result, origin?: string): void {
  const common = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...(origin ? { "access-control-allow-origin": origin, vary: "origin" } : {}),
  };
  if (out.bytes) {
    // Ciphertext, served as opaque bytes: never as audio a browser could sniff or play.
    res.writeHead(out.httpStatus, { ...common, "content-type": "application/octet-stream", "content-length": out.bytes.length });
    return void res.end(out.bytes);
  }
  res.writeHead(out.httpStatus, { ...common, "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(out.body ?? {}));
}

async function readBytes(req: IncomingMessage, max: number): Promise<Uint8Array> {
  if (!/^application\/octet-stream\b/i.test(req.headers["content-type"] ?? "")) throw Object.assign(new Error(), { status: 415, code: "UnsupportedMediaType" });
  const declared = Number(req.headers["content-length"] ?? "0");
  if (declared > max) throw Object.assign(new Error(), { status: 413, code: "MessageTooLarge" });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw Object.assign(new Error(), { status: 413, code: "MessageTooLarge" });
    chunks.push(c as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
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

export function createVoiceServer(svc: VoiceService): Server {
  const origin = svc.cfg.allowedOrigin;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "OPTIONS" && origin) {
        res.writeHead(204, {
          "access-control-allow-origin": origin, "access-control-allow-methods": "GET, PUT, POST", "access-control-allow-headers": "content-type", "access-control-max-age": "600",
        });
        return void res.end();
      }
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, { httpStatus: 200, body: svc.health() }, origin);
      const m = PATH.exec(url.pathname);
      if (!m) return send(res, { httpStatus: 404, body: { error: "NotFound" } }, origin);
      const locator = m[1].toLowerCase();
      const ip = process.env.TRUST_PROXY === "1" ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || "unknown" : req.socket.remoteAddress ?? "unknown";
      if (m[2]) {
        if (req.method !== "POST") return send(res, { httpStatus: 405, body: { error: "MethodNotAllowed" } }, origin);
        return send(res, await svc.bind(locator, await readJson(req, 1024), ip), origin);
      }
      if (req.method === "GET") return send(res, svc.get(locator, ip), origin);
      if (req.method === "PUT") return send(res, svc.put(locator, await readBytes(req, MAX_UPLOAD_BYTES), ip), origin);
      return send(res, { httpStatus: 405, body: { error: "MethodNotAllowed" } }, origin);
    } catch (e) {
      const x = e as { status?: number; code?: string };
      if (x.status && x.code) return send(res, { httpStatus: x.status, body: { error: x.code } }, origin);
      log("error", "http.unhandled", { err: String(e) });
      if (!res.headersSent) return send(res, { httpStatus: 500, body: { error: "InternalError" } }, origin);
      res.destroy();
    }
  });
  server.on("clientError", (_e, socket) => socket.destroy());
  return server;
}
