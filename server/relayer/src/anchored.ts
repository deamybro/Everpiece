import { createHmac, randomUUID } from "node:crypto";
import { ANCHORED_MONAD } from "@everpiece/shared";

/**
 * Anchored RWA Trading API client (docs.anchored.finance "HMAC Authentication", "Environments & Chains",
 * "Self-Submit On-Chain"). Server-side only: keys never reach a browser. Anchored binds every key to ONE trading
 * wallet (orders must come from its userAddress) and requires a KYC'd professional/qualified investor behind it, so
 * this client is used per wallet with that wallet's own key — Everpiece has none today (docs/INVEST.md).
 */
export type AnchoredCredentials = { apiKey: string; apiSecret: string };

/** URI with its query sorted by name (the documented canonical form); arrays repeat the key. */
export function canonicalUri(path: string, query: Record<string, string | number | (string | number)[] | undefined> = {}): string {
  const pairs: string[] = [];
  for (const k of Object.keys(query).sort()) {
    const v = query[k];
    if (Array.isArray(v)) for (const x of v) pairs.push(`${k}=${x}`);
    else if (v !== undefined) pairs.push(`${k}=${v}`);
  }
  return pairs.length ? `${path}?${pairs.join("&")}` : path;
}

/** x-api-sign = hex(HMAC_SHA256(METHOD\nURI\nTIMESTAMP\nNONCE\nRAW_BODY, secret)). */
export function signAnchored(a: { method: string; uri: string; timestamp: number; nonce: string; rawBody: string; apiSecret: string }): string {
  const payload = [a.method.toUpperCase(), a.uri, String(a.timestamp), a.nonce, a.rawBody].join("\n");
  return createHmac("sha256", a.apiSecret).update(payload, "utf8").digest("hex");
}

export type AnchoredEnvelope<T> = { code: number; errMsg: string; data: T };

export class AnchoredClient {
  private readonly creds: AnchoredCredentials;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  constructor(creds: AnchoredCredentials, opts: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.creds = creds;
    this.fetchFn = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  private async call<T>(method: "GET" | "POST", path: string, query: Record<string, string | number | undefined> = {}, body?: unknown): Promise<AnchoredEnvelope<T>> {
    const uri = canonicalUri(path, query);
    const rawBody = body === undefined ? "" : JSON.stringify(body);
    const timestamp = this.now();
    const nonce = randomUUID();
    const r = await this.fetchFn(`${ANCHORED_MONAD.apiBase}${uri}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "x-api-key": this.creds.apiKey,
        "x-api-ts": String(timestamp),
        "x-api-nonce": nonce,
        "x-api-sign": signAnchored({ method, uri, timestamp, nonce, rawBody, apiSecret: this.creds.apiSecret }),
        "x-api-chain-id": String(ANCHORED_MONAD.chainId),
        "x-api-p": ANCHORED_MONAD.product,
      },
      body: body === undefined ? undefined : rawBody,
      signal: AbortSignal.timeout(15_000),
    });
    const env = (await r.json().catch(() => null)) as AnchoredEnvelope<T> | null;
    if (!r.ok || !env || env.code !== 200) throw new Error(`anchored ${method} ${path}: HTTP ${r.status} ${env?.errMsg ?? ""}`.trim());
    return env;
  }

  /** Tradable symbols (contractAddress = the stock token to order). */
  symbols() {
    return this.call<{ symbol: string; contractAddress: string; tradable: boolean; fractionable: boolean; price: number }[]>("GET", "/api/v1/symbols");
  }

  /** Self-submit market buy: Anchored returns the StockRouter call the bound wallet itself signs and sends. */
  marketBuyCalldata(stockAddress: string, notionalUsd: string, deadlineSec: number) {
    return this.call<{ toAddress: string; callData: string; value: string }>("POST", "/api/v1/orders/calldata", {}, {
      stockAddress, side: "Buy", type: "Market", notional: notionalUsd, deadline: deadlineSec,
    });
  }

  recordOrderTx(txHash: string) {
    return this.call<unknown>("POST", "/api/v1/orders/tx", {}, { txHash });
  }

  orderByTx(txHash: string) {
    return this.call<{ orderId?: string; status?: string }>("GET", `/api/v1/orders/tx/${txHash}`);
  }
}
