import { getAddress, isAddress, isHex, type Address } from "viem";
import {
  FundingError,
  auroraQuoteRequest,
  destinationAssetId,
  fundingPhase,
  fundingSources,
  parseAuroraQuote,
  parseAuroraStatus,
  type FundingSource,
} from "@everpiece/shared";
import { log } from "./log.ts";

/**
 * "Add Dollars from another chain" through Aurora Intents (packages/shared/src/funding.ts, docs/FUNDING.md).
 * The relayer only proxies: the API key stays on the server, every quote is checked against what was asked before
 * the app sees it, and nothing here moves money (the payer sends on the origin chain; Aurora delivers on Monad).
 */
export type FundingConfig = {
  apiUrl: string;
  apiKey: string;
  /** The token Aurora delivers on Monad; it must be payable through EverpiecePay (mainnet: USDC). */
  destinationToken: Address;
  slippageBps: number;
  deadlineMinutes: number;
  /** Offer Aurora's confidential routing (hides the origin wallet and route; destination stays public). Off unless the operator enables it. */
  confidential?: boolean;
  /** Largest single top-up, in whole destination tokens. */
  maxWholeTokens: number;
  perIpPerMinute: number;
};

export type ApiResult = { httpStatus: number; body: Record<string, unknown> };

class Limiter {
  private hits = new Map<string, number[]>();
  private readonly perMinute: number;
  constructor(perMinute: number) {
    this.perMinute = perMinute;
  }
  allow(key: string, now: number): boolean {
    const w = (this.hits.get(key) ?? []).filter((t) => now - t < 60_000);
    const ok = w.length < this.perMinute;
    if (ok) w.push(now);
    this.hits.set(key, w);
    return ok;
  }
}

const TOKENS_TTL_MS = 5 * 60_000;
const UPSTREAM_TIMEOUT_MS = 15_000;
const err = (httpStatus: number, error: string): ApiResult => ({ httpStatus, body: { error } });
const wire = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

export class Funding {
  private tokens: { at: number; list: unknown[] } | null = null;
  private readonly limiter: Limiter;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  readonly cfg: FundingConfig;

  constructor(cfg: FundingConfig, opts: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.cfg = cfg;
    this.limiter = new Limiter(cfg.perIpPerMinute);
    this.fetchFn = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** Calls Aurora. The URL contains the API key, so it never reaches a log or an error message. */
  private async upstream(path: string, init?: { method: "POST"; body: unknown }): Promise<{ status: number; body: unknown }> {
    const url = `${this.cfg.apiUrl}/${path}`;
    try {
      const r = await this.fetchFn(url, {
        method: init?.method ?? "GET",
        headers: init ? { "content-type": "application/json" } : undefined,
        body: init ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    } catch (e) {
      log("warn", "funding.upstream_unreachable", { path: path.split("/")[0], err: (e as Error).name });
      return { status: 0, body: null };
    }
  }

  private async tokenList(): Promise<unknown[] | null> {
    if (this.tokens && this.now() - this.tokens.at < TOKENS_TTL_MS) return this.tokens.list;
    const r = await this.upstream(`tokens/${this.cfg.apiKey}`);
    if (r.status !== 200 || !Array.isArray(r.body)) return this.tokens?.list ?? null;
    this.tokens = { at: this.now(), list: r.body };
    return r.body;
  }

  private async resolve(): Promise<{ sources: FundingSource[]; destination: string; destinationDecimals: number } | ApiResult> {
    const list = await this.tokenList();
    if (!list) return err(503, "PROVIDER_UNAVAILABLE");
    const destination = destinationAssetId(list, this.cfg.destinationToken);
    if (!destination) return err(503, "NO_ROUTE");
    const destinationDecimals = (list as { assetId?: string; decimals?: number }[]).find((t) => t?.assetId === destination)!.decimals!;
    return { sources: fundingSources(list), destination, destinationDecimals };
  }

  private limited(ip: string, what: string): ApiResult | null {
    return this.limiter.allow(`${what}:${ip}`, this.now()) ? null : err(429, "RateLimited");
  }

  async sources(ip: string): Promise<ApiResult> {
    const l = this.limited(ip, "sources");
    if (l) return l;
    const r = await this.resolve();
    if ("httpStatus" in r) return r;
    return { httpStatus: 200, body: { sources: r.sources, destinationToken: this.cfg.destinationToken, destinationDecimals: r.destinationDecimals } };
  }

  async quote(body: unknown, ip: string): Promise<ApiResult> {
    const l = this.limited(ip, "quote");
    if (l) return l;
    const o = (body ?? {}) as Record<string, unknown>;
    const keys = Object.keys(o).sort().join(",");
    const wantsConfidential = o.confidential === true;
    if (keys !== "amountOut,originAssetId,recipient,refundTo" && keys !== "amountOut,confidential,originAssetId,recipient,refundTo") return err(400, "InvalidRequest");
    if ("confidential" in o && typeof o.confidential !== "boolean") return err(400, "InvalidRequest");
    if (wantsConfidential && !this.cfg.confidential) return err(422, "CONFIDENTIAL_UNAVAILABLE");
    if (typeof o.originAssetId !== "string" || typeof o.amountOut !== "string" || !/^[1-9][0-9]{0,39}$/.test(o.amountOut)) return err(400, "InvalidRequest");
    if (typeof o.recipient !== "string" || !isAddress(o.recipient) || typeof o.refundTo !== "string" || !isAddress(o.refundTo)) return err(400, "InvalidRequest");
    const r = await this.resolve();
    if ("httpStatus" in r) return r;
    const origin = r.sources.find((s) => s.assetId === o.originAssetId);
    if (!origin) return err(422, "UNSUPPORTED_TOKEN");
    const amountOut = BigInt(o.amountOut);
    if (amountOut > BigInt(this.cfg.maxWholeTokens) * 10n ** BigInt(r.destinationDecimals)) return err(422, "AMOUNT_TOO_LARGE");
    const asked = {
      origin, destinationAssetId: r.destination, amountOut, recipient: getAddress(o.recipient), refundTo: getAddress(o.refundTo),
      deadline: new Date(this.now() + this.cfg.deadlineMinutes * 60_000).toISOString(), slippageBps: this.cfg.slippageBps, confidential: wantsConfidential,
    };
    const up = await this.upstream(`quote/${this.cfg.apiKey}`, { method: "POST", body: auroraQuoteRequest(asked) });
    if (up.status === 0 || up.status >= 500) return err(503, "PROVIDER_UNAVAILABLE");
    if (up.status !== 200 && up.status !== 201) {
      const m = (up.body as { message?: unknown } | null)?.message;
      log("info", "funding.quote_refused", { status: up.status, origin: origin.chain });
      return { httpStatus: 422, body: { error: "QUOTE_REFUSED", detail: typeof m === "string" ? m.slice(0, 160) : undefined } };
    }
    try {
      const quote = parseAuroraQuote(up.body, asked, this.now());
      log("info", "funding.quote", { origin: origin.chain, amountOut: amountOut.toString(), amountIn: quote.amountIn.toString() });
      return { httpStatus: 200, body: { quote: wire(quote), origin: wire(origin) } };
    } catch (e) {
      log("alert", "funding.bad_quote", { origin: origin.chain, why: (e as FundingError).message.slice(0, 120) });
      return err(502, "BAD_QUOTE");
    }
  }

  /** The payer's origin-chain transaction, so Aurora picks the deposit up sooner (optional for the payer). */
  async deposit(body: unknown, ip: string): Promise<ApiResult> {
    const l = this.limited(ip, "deposit");
    if (l) return l;
    const o = (body ?? {}) as Record<string, unknown>;
    if (typeof o.depositAddress !== "string" || !isAddress(o.depositAddress)) return err(400, "InvalidRequest");
    if (typeof o.txHash !== "string" || !isHex(o.txHash) || o.txHash.length !== 66) return err(400, "InvalidRequest");
    const up = await this.upstream(`deposit/submit/${this.cfg.apiKey}`, { method: "POST", body: { txHash: o.txHash, depositAddress: o.depositAddress } });
    if (up.status === 0 || up.status >= 500) return err(503, "PROVIDER_UNAVAILABLE");
    if (up.status !== 200 && up.status !== 201) return err(422, "DEPOSIT_REFUSED");
    return this.statusOf(o.depositAddress);
  }

  async status(depositAddress: string, ip: string): Promise<ApiResult> {
    const l = this.limited(ip, "status");
    if (l) return l;
    if (!isAddress(depositAddress)) return err(400, "InvalidRequest");
    return this.statusOf(depositAddress);
  }

  private async statusOf(depositAddress: string): Promise<ApiResult> {
    const up = await this.upstream(`status/${this.cfg.apiKey}?depositAddress=${encodeURIComponent(getAddress(depositAddress))}`);
    if (up.status === 404) return err(404, "UNKNOWN_DEPOSIT");
    if (up.status !== 200) return err(503, "PROVIDER_UNAVAILABLE");
    try {
      const s = parseAuroraStatus(up.body);
      return { httpStatus: 200, body: { ...s, phase: fundingPhase(s.status) } };
    } catch {
      return err(502, "BAD_STATUS");
    }
  }
}
