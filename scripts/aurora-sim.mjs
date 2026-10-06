// SIMULATED Aurora Intents for the test site (Aurora is mainnet-only). It speaks the same API paths and shapes as the
// real service (docs.intents.aurora.dev → API reference) so the relayer's real adapter runs unchanged against it.
// Nothing crosses a chain: "Base (simulated)" USDC is never received; when the app says the deposit was sent, the
// stack's own wallet delivers the destination token (test CTK) to the payer on Monad testnet. Test money only.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { getAddress, isAddress } from "viem";

const SESSION_TTL_MS = 2 * 60 * 60_000;
const DELIVERIES_PER_RECIPIENT_PER_DAY = 5;

/**
 * @param {{ port: number, host?: string, destinationToken: `0x${string}`, destinationDecimals: number,
 *           deliver: (to: `0x${string}`, amount: bigint) => Promise<`0x${string}`>, say?: (m: string) => void }} o
 */
export function startAuroraSimulator(o) {
  const ORIGIN_ASSET = "sim:base-usdc";
  const DEST_ASSET = "sim:monad-destination";
  const tokens = [
    // real Base USDC contract, labelled sim-base so the app shows "Base (simulated)"
    { assetId: ORIGIN_ASSET, decimals: 6, blockchain: "sim-base", symbol: "USDC", price: 1, contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
    { assetId: DEST_ASSET, decimals: o.destinationDecimals, blockchain: "monad", symbol: "SIM", price: 1, contractAddress: o.destinationToken.toLowerCase() },
  ];
  /** depositAddress → session */
  const sessions = new Map();
  const deliveries = new Map();
  const say = o.say ?? (() => {});

  const json = (res, status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  const body = async (req) => {
    let raw = "";
    for await (const c of req) {
      raw += c;
      if (raw.length > 8192) throw new Error("too large");
    }
    return JSON.parse(raw || "{}");
  };
  const sweep = () => {
    const now = Date.now();
    for (const [k, s] of sessions) if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(k);
  };

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://sim");
    const parts = url.pathname.split("/").filter(Boolean); // api, <op>, [sub], key
    if (parts[0] !== "api") return json(res, 404, { message: "not found" });
    if (req.method === "GET" && parts[1] === "tokens") return json(res, 200, tokens);

    if (req.method === "POST" && parts[1] === "quote") {
      const q = await body(req);
      if (q.swapType !== "EXACT_OUTPUT" || q.originAsset !== ORIGIN_ASSET || q.destinationAsset !== DEST_ASSET) return json(res, 400, { message: "unsupported route" });
      if (typeof q.amount !== "string" || !/^[1-9][0-9]{0,39}$/.test(q.amount)) return json(res, 400, { message: "bad amount" });
      if (!isAddress(q.recipient ?? "") || !isAddress(q.refundTo ?? "")) return json(res, 400, { message: "bad address" });
      sweep();
      const amountOut = BigInt(q.amount);
      // price 1:1 in dollars; the origin has 6 decimals; a simulated 0.3% fee plus the requested input buffer
      const scale = 10n ** BigInt(Math.max(0, o.destinationDecimals - 6));
      const base = (amountOut + scale - 1n) / scale;
      const minAmountIn = base + (base * 30n + 9_999n) / 10_000n;
      const amountIn = minAmountIn + (minAmountIn * BigInt(q.slippageTolerance ?? 0) + 9_999n) / 10_000n;
      const depositAddress = getAddress(`0x${randomBytes(20).toString("hex")}`);
      sessions.set(depositAddress, { recipient: getAddress(q.recipient), amountOut, status: "PENDING_DEPOSIT", createdAt: Date.now(), hash: null });
      const usd = (v) => (Number(v) / 1e6).toFixed(2);
      return json(res, 200, {
        timestamp: new Date().toISOString(), signature: "simulated", quoteRequest: q,
        quote: {
          depositAddress, amountIn: amountIn.toString(), amountInFormatted: usd(amountIn), amountInUsd: usd(amountIn), minAmountIn: minAmountIn.toString(),
          amountOut: amountOut.toString(), amountOutFormatted: usd(base), amountOutUsd: usd(base), minAmountOut: amountOut.toString(),
          deadline: q.deadline, timeEstimate: 10,
        },
      });
    }

    if (req.method === "POST" && parts[1] === "deposit" && parts[2] === "submit") {
      const d = await body(req);
      const s = isAddress(d.depositAddress ?? "") ? sessions.get(getAddress(d.depositAddress)) : undefined;
      if (!s) return json(res, 404, { message: "unknown deposit address" });
      if (s.status === "PENDING_DEPOSIT") {
        const day = `${s.recipient}:${new Date().toISOString().slice(0, 10)}`;
        if ((deliveries.get(day) ?? 0) >= DELIVERIES_PER_RECIPIENT_PER_DAY) {
          s.status = "REFUNDED";
        } else {
          deliveries.set(day, (deliveries.get(day) ?? 0) + 1);
          s.status = "KNOWN_DEPOSIT_TX";
          setTimeout(() => {
            s.status = "PROCESSING";
            o.deliver(s.recipient, s.amountOut)
              .then((hash) => {
                s.hash = hash;
                s.status = "SUCCESS";
                say(`aurora-sim: delivered ${s.amountOut} to ${s.recipient}`);
              })
              .catch((e) => {
                s.status = "FAILED";
                say(`aurora-sim: delivery failed: ${String(e?.shortMessage ?? e).slice(0, 100)}`);
              });
          }, 2_000);
        }
      }
      return json(res, 200, { status: s.status });
    }

    if (req.method === "GET" && parts[1] === "status") {
      const a = url.searchParams.get("depositAddress") ?? "";
      const s = isAddress(a) ? sessions.get(getAddress(a)) : undefined;
      if (!s) return json(res, 404, { message: "unknown deposit address" });
      return json(res, 200, {
        status: s.status, updatedAt: new Date().toISOString(),
        swapDetails: { destinationChainTxHashes: s.hash ? [{ hash: s.hash, explorerUrl: "" }] : [], refundedAmount: s.status === "REFUNDED" ? "1" : "0" },
      });
    }
    return json(res, 404, { message: "not found" });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 400, { message: "bad request" });
    });
  });
  server.listen(o.port, o.host ?? "127.0.0.1");
  return server;
}
