import { createHmac, timingSafeEqual } from "node:crypto";
import { getAddress, isAddress, type Address } from "viem";
import { log } from "./log.ts";

/**
 * Paycrest Sender API v2 (VERIFIED §4.15): envelope {status, message, data}; header API-Key; webhooks signed with
 * X-Paycrest-Signature = hex HMAC-SHA256(API secret, raw body). The same client talks to the test site's SIMULATED
 * Paycrest (scripts/paycrest-sim.mjs), so the real code path runs there too.
 */
export type Institution = { name: string; code: string; type: string };
export type CreateOrder = {
  /** Stablecoin amount, decimal string (e.g. "33.42"). */
  amount: string;
  currency: string;
  network: string;
  refundAddress: Address;
  institution: string;
  accountIdentifier: string;
  accountName: string;
  memo: string;
  reference: string;
};
export type ProviderOrder = { id: string; status: string; receiveAddress: Address; amountToTransfer: string; currency: string; validUntil: string };

export class ProviderError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, httpStatus: number, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const TIMEOUT_MS = 20_000;

export class Paycrest {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly secret: string;
  private readonly fetchFn: typeof fetch;
  constructor(base: string, apiKey: string, secret: string, fetchFn: typeof fetch = fetch) {
    this.base = base;
    this.apiKey = apiKey;
    this.secret = secret;
    this.fetchFn = fetchFn;
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    let r: Response;
    try {
      r = await this.fetchFn(`${this.base}${path}`, {
        method,
        headers: { "API-Key": this.apiKey, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      log("warn", "paycrest.unreachable", { path: path.split("/").slice(0, 3).join("/"), err: (e as Error).name });
      throw new ProviderError("PROVIDER_UNAVAILABLE", 503);
    }
    const j = (await r.json().catch(() => null)) as { status?: string; message?: string; data?: unknown } | null;
    if (r.status >= 500 || !j) throw new ProviderError("PROVIDER_UNAVAILABLE", 503);
    if (r.status !== 200 && r.status !== 201) throw new ProviderError("PROVIDER_REFUSED", 422, typeof j.message === "string" ? j.message.slice(0, 160) : undefined);
    return j.data;
  }

  async institutions(currency: string): Promise<Institution[]> {
    const d = await this.call("GET", `/v2/institutions/${encodeURIComponent(currency)}`);
    if (!Array.isArray(d)) throw new ProviderError("PROVIDER_UNAVAILABLE", 503);
    return d.filter((x): x is Institution => x && typeof x.name === "string" && typeof x.code === "string" && typeof x.type === "string");
  }

  /** The canonical account holder name, or null when the bank's name lookup is unavailable ("OK"). */
  async verifyAccount(institution: string, accountIdentifier: string): Promise<string | null> {
    const d = await this.call("POST", "/v2/verify-account", { institution, accountIdentifier });
    if (typeof d !== "string" || !d.trim()) throw new ProviderError("ACCOUNT_NOT_FOUND", 422);
    return d.trim().toUpperCase() === "OK" ? null : d.trim();
  }

  /** Naira per unit of stablecoin for an off-ramp ("sell") of `amount` units. */
  async sellRate(network: string, currency: string, amount: string, fiat: string): Promise<string> {
    const d = (await this.call("GET", `/v2/rates/${network}/${currency}/${amount}/${fiat}`)) as { sell?: { rate?: unknown } } | null;
    const rate = d?.sell?.rate;
    if (typeof rate !== "string" || !/^[0-9]{1,12}(\.[0-9]{1,12})?$/.test(rate) || Number(rate) <= 0) throw new ProviderError("NO_RATE", 503);
    return rate;
  }

  async createOrder(o: CreateOrder): Promise<ProviderOrder> {
    const d = (await this.call("POST", "/v2/sender/orders", {
      amount: o.amount,
      source: { type: "crypto", currency: o.currency, network: o.network, refundAddress: o.refundAddress },
      destination: {
        type: "fiat", currency: "NGN",
        recipient: { institution: o.institution, accountIdentifier: o.accountIdentifier, accountName: o.accountName, memo: o.memo },
      },
      reference: o.reference,
    })) as { id?: unknown; status?: unknown; providerAccount?: Record<string, unknown> } | null;
    const p = d?.providerAccount;
    if (!d || typeof d.id !== "string" || !p || typeof p.receiveAddress !== "string" || !isAddress(p.receiveAddress, { strict: false }))
      throw new ProviderError("BAD_ORDER", 502);
    if (typeof p.amountToTransfer !== "string" || !/^[0-9]{1,12}(\.[0-9]{1,18})?$/.test(p.amountToTransfer)) throw new ProviderError("BAD_ORDER", 502);
    if (typeof p.validUntil !== "string" || !Number.isFinite(Date.parse(p.validUntil))) throw new ProviderError("BAD_ORDER", 502);
    return {
      id: d.id, status: String(d.status ?? "initiated"), receiveAddress: getAddress(p.receiveAddress), amountToTransfer: p.amountToTransfer,
      currency: String(p.currency ?? o.currency), validUntil: p.validUntil,
    };
  }

  async orderStatus(id: string): Promise<string> {
    const d = (await this.call("GET", `/v2/sender/orders/${encodeURIComponent(id)}`)) as { status?: unknown } | null;
    if (typeof d?.status !== "string") throw new ProviderError("BAD_ORDER", 502);
    return d.status;
  }

  /** Webhook authenticity: hex HMAC-SHA256(secret, raw body), timing-safe on the UTF-8 hex strings (as documented). */
  verifyWebhook(rawBody: Uint8Array | string, header: string | undefined): boolean {
    if (!header) return false;
    const got = Buffer.from(header.trim().toLowerCase(), "utf8");
    const want = Buffer.from(createHmac("sha256", this.secret).update(rawBody).digest("hex"), "utf8");
    return got.length === want.length && timingSafeEqual(got, want);
  }
}
