// SIMULATED Paycrest (Sender API v2 shapes: envelope {status, message, data}, API-Key header, HMAC-signed webhooks;
// docs/VERIFIED.md §4.15) for the test site and tests. Paycrest has no sandbox ("mainnet only").
// Real where it can be: the bank list and the NGN rate are fetched from Paycrest's PUBLIC endpoints (no key).
// Simulated: account-name lookup, orders, deposit detection (an injected balance check: on the test site, test AUSD
// arriving at the order's deposit address on Monad testnet), the bank payout itself, and refunds. No bank is paid.
//
// Test account numbers: 0000000000 → not found · 1111111111 → bank can't confirm names · 2222222222 → payout
// fails and is refunded · anything else → "TEST ACCOUNT ••1234 (SIMULATED)" and a successful simulated payout.
import { createServer } from "node:http";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { getAddress } from "viem";

const PUBLIC = "https://api.paycrest.io";
const ok = (data, message = "OK") => ({ status: "success", message, data });
const bad = (message) => ({ status: "error", message, data: null });

/**
 * @param {{ port: number, host?: string, apiKey: string, apiSecret: string, webhookUrl?: string,
 *   balanceOf: (addr: `0x${string}`) => Promise<bigint>, refund?: (to: `0x${string}`, units: bigint) => Promise<string>,
 *   decimals?: number, rate?: string, institutions?: {name:string,code:string,type:string}[], feeUnits?: bigint,
 *   stepMs?: number, say?: (m: string) => void }} o
 */
export function startPaycrestSimulator(o) {
  const decimals = o.decimals ?? 6;
  const stepMs = o.stepMs ?? 3000;
  const say = o.say ?? (() => {});
  const orders = new Map();
  let institutionsCache = null;

  const units = (s) => {
    const [i, f = ""] = String(s).split(".");
    return BigInt(i) * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
  };
  const decimal = (u) => `${u / 10n ** BigInt(decimals)}.${(u % 10n ** BigInt(decimals)).toString().padStart(decimals, "0")}`.replace(/\.?0+$/, "");

  async function institutions() {
    if (o.institutions) return o.institutions;
    if (institutionsCache) return institutionsCache;
    const r = await fetch(`${PUBLIC}/v2/institutions/NGN`, { signal: AbortSignal.timeout(15_000) });
    const j = await r.json();
    institutionsCache = j.data;
    return institutionsCache;
  }
  async function rate() {
    if (o.rate) return o.rate;
    const r = await fetch(`${PUBLIC}/v2/rates/base/USDC/100/NGN`, { signal: AbortSignal.timeout(15_000) }); // the real public rate
    const j = await r.json();
    return j.data.sell.rate;
  }

  async function webhook(order, event) {
    if (!o.webhookUrl) return;
    const body = JSON.stringify({ event, webhookVersion: "2", data: { id: order.id, direction: "offramp", status: order.status } });
    const sig = createHmac("sha256", o.apiSecret).update(body).digest("hex");
    await fetch(o.webhookUrl, { method: "POST", headers: { "content-type": "application/json", "x-paycrest-signature": sig }, body }).catch(() => {});
  }
  async function advance(order, status, event) {
    order.status = status;
    say(`paycrest-sim: ${order.id.slice(0, 8)} → ${status}`);
    await webhook(order, event);
  }

  // deposit watcher + simulated bank payout
  const timer = setInterval(async () => {
    for (const order of orders.values()) {
      if (order.busy) continue;
      order.busy = true;
      try {
        if (order.status === "initiated") {
          if (Date.now() > Date.parse(order.validUntil)) await advance(order, "expired", "payment_order.expired");
          else if ((await o.balanceOf(order.receiveAddress)) >= units(order.amountToTransfer)) {
            await advance(order, "deposited", "payment_order.deposited");
            order.at = Date.now();
          }
        } else if (order.status === "deposited" && Date.now() - order.at > stepMs) {
          await advance(order, "pending", "payment_order.pending");
          order.at = Date.now();
        } else if (order.status === "pending" && Date.now() - order.at > stepMs) {
          if (order.accountIdentifier === "2222222222") {
            await advance(order, "refunding", "payment_order.refunding");
            if (o.refund) await o.refund(order.refundAddress, units(order.amountToTransfer)).catch((e) => say(`paycrest-sim: refund failed ${String(e).slice(0, 80)}`));
            await advance(order, "refunded", "payment_order.refunded");
          } else {
            await advance(order, "validated", "payment_order.validated");
            order.at = Date.now();
          }
        } else if (order.status === "validated" && Date.now() - order.at > stepMs) {
          await advance(order, "settled", "payment_order.settled");
        }
      } catch (e) {
        say(`paycrest-sim: ${String(e).slice(0, 100)}`);
      } finally {
        order.busy = false;
      }
    }
  }, Math.min(stepMs, 3000));

  const json = (res, status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  async function readJson(req) {
    let raw = "";
    for await (const c of req) {
      raw += c;
      if (raw.length > 8192) throw new Error("too large");
    }
    return JSON.parse(raw || "{}");
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://sim");
    const p = url.pathname;
    let m;
    if (req.method === "GET" && p === "/v2/institutions/NGN") return json(res, 200, ok(await institutions()));
    if (req.method === "GET" && (m = /^\/v2\/rates\/[^/]+\/[^/]+\/[^/]+\/NGN$/.exec(p))) {
      return json(res, 200, ok({ sell: { rate: await rate(), providerIds: ["SIMULATD"], orderType: "regular", refundTimeoutMinutes: 2 } }, "Rate fetched successfully"));
    }
    if (req.headers["api-key"] !== o.apiKey) return json(res, 401, bad("Invalid API key"));
    if (req.method === "POST" && p === "/v2/verify-account") {
      const b = await readJson(req);
      const n = String(b.accountIdentifier ?? "");
      if (!/^[0-9]{10}$/.test(n) || n === "0000000000") return json(res, 400, bad("Account not found"));
      if (n === "1111111111") return json(res, 200, ok("OK"));
      return json(res, 200, ok(`TEST ACCOUNT ${n.slice(-4)} (SIMULATED)`));
    }
    if (req.method === "POST" && p === "/v2/sender/orders") {
      const b = await readJson(req);
      if (b?.source?.type !== "crypto" || b?.destination?.type !== "fiat" || b.destination.currency !== "NGN") return json(res, 400, bad("Unsupported order"));
      if (!/^[0-9]{1,12}(\.[0-9]{1,18})?$/.test(String(b.amount))) return json(res, 400, bad("Invalid amount"));
      const id = randomUUID();
      const fee = o.feeUnits ?? 0n;
      const order = {
        id, status: "initiated", receiveAddress: getAddress(`0x${randomBytes(20).toString("hex")}`), amountToTransfer: decimal(units(b.amount) + fee),
        currency: b.source.currency, validUntil: new Date(Date.now() + 15 * 60_000).toISOString(), refundAddress: b.source.refundAddress,
        accountIdentifier: String(b.destination.recipient?.accountIdentifier ?? ""), reference: b.reference,
      };
      orders.set(id, order);
      return json(res, 201, ok({ id, status: "initiated", providerAccount: { receiveAddress: order.receiveAddress, validUntil: order.validUntil, amountToTransfer: order.amountToTransfer, currency: order.currency } }, "Order created"));
    }
    if (req.method === "GET" && (m = /^\/v2\/sender\/orders\/([0-9a-f-]{36})$/.exec(p))) {
      const order = orders.get(m[1]);
      if (!order) return json(res, 404, bad("Order not found"));
      return json(res, 200, ok({ id: order.id, status: order.status, amount: order.amountToTransfer, reference: order.reference }));
    }
    return json(res, 404, bad("not found"));
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 400, bad("bad request"));
    });
  });
  server.on("close", () => clearInterval(timer));
  server.listen(o.port, o.host ?? "127.0.0.1");
  return server;
}
