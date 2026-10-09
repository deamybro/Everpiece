import { BaseError, ContractFunctionRevertedError, HttpRequestError, TimeoutError, keccak256, parseEventLogs, type Hex } from "viem";
import { AUSD_USDC_V4_POOL, UNISWAP_V4_MONAD, routeOf, settlementAsset, v4QuoterAbi, type ConversionQuote } from "@everpiece/shared";
import { everpieceAutomateAbi } from "@everpiece/shared";
import { agoraPairAbi, everpieceEarnAbi, everpieceEscrowAbi, everpiecePayAbi, everpiecePayV2Abi, PaymentStatus, ausdAbi, tokenFor, type RouteQuote } from "@everpiece/shared";
import { randomUUID } from "node:crypto";
import { AUTOMATE_METHODS, EARN_METHODS, EARN_USDC_METHODS, METHODS, PAY_METHODS, PAY_V2_METHODS, type Method, type RelayerConfig } from "./config.ts";
import { connect, readPayment, relayAbi, startupChecks, type Chain } from "./chain.ts";
import { prepare, PrecheckError, type EscrowEvent } from "./actions.ts";
import { Store, type RequestRow } from "./store.ts";
import { ValidationError, parseQuote, parseQuoteV2 } from "./validate.ts";
import { LocalRulesPolicy, decide, type ComplianceProvider } from "./policy.ts";
import { log } from "./log.ts";
import { Funding } from "./funding.ts";

export type ApiResult = { httpStatus: number; body: Record<string, unknown> };

const EXPECTED: Record<Method, { event: EscrowEvent; status: number }> = {
  createPayment: { event: "PaymentCreated", status: PaymentStatus.ACTIVE },
  claimUsernamePayment: { event: "PaymentClaimed", status: PaymentStatus.CLAIMED },
  claimLinkPayment: { event: "PaymentClaimed", status: PaymentStatus.CLAIMED },
  cancel: { event: "PaymentCancelled", status: PaymentStatus.CANCELLED },
  refundExpired: { event: "PaymentRefunded", status: PaymentStatus.REFUNDED },
  payWithAusd: { event: "Paid", status: 1 },
  payWithToken: { event: "Paid", status: 1 },
  earnDeposit: { event: "EarnDeposited", status: 1 },
  earnWithdraw: { event: "EarnWithdrawn", status: 1 },
  earnUsdcDeposit: { event: "EarnDeposited", status: 1 },
  earnUsdcWithdraw: { event: "EarnWithdrawn", status: 1 },
  automateActivate: { event: "GrantActivated", status: 1 },
  automateRevoke: { event: "GrantRevoked", status: 1 },
  automateExecute: { event: "Executed", status: 1 },
  payV2Direct: { event: "Paid", status: 1 },
  payV2Convert: { event: "Paid", status: 1 },
};

const isPay = (m: Method) => PAY_METHODS.includes(m);
/** EverpiecePay ABI + AUSD errors, so pay simulations decode Agora/AUSD/pay reverts by name. */
const payRelayAbi = [...everpiecePayAbi, ...ausdAbi.filter((x) => x.type === "error")] as const;
const isEarn = (m: Method) => EARN_METHODS.includes(m);
const isPayV2 = (m: Method) => PAY_V2_METHODS.includes(m);
/** EverpiecePayV2 ABI + AUSD errors (USDC reverts with strings, which viem decodes as Error(string)). */
const payV2RelayAbi = [...everpiecePayV2Abi, ...ausdAbi.filter((x) => x.type === "error")] as const;
const earnRelayAbi = [...everpieceEarnAbi, ...ausdAbi.filter((x) => x.type === "error")] as const;

/** Sliding-window limiter (in-memory; per process). */
class RateLimiter {
  private hits = new Map<string, number[]>();
  private readonly perMinute: number;
  constructor(perMinute: number) {
    this.perMinute = perMinute;
  }
  allow(key: string, now: number): boolean {
    const w = (this.hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (w.length >= this.perMinute) {
      this.hits.set(key, w);
      return false;
    }
    w.push(now);
    this.hits.set(key, w);
    return true;
  }
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayStart = (ms: number) => Date.parse(utcDay(ms) + "T00:00:00Z");

export function publicView(r: RequestRow): Record<string, unknown> {
  return {
    requestId: r.id,
    method: r.method,
    status: r.status,
    paymentId: r.payment_id,
    txHash: r.tx_hash,
    blockNumber: r.included_block,
    gasUsed: r.gas_used,
    chainStatus: r.chain_status,
    error: r.error,
  };
}

export class Relayer {
  readonly cfg: RelayerConfig;
  /** Cross-chain top-ups (null when AURORA_API_KEY isn't configured). */
  readonly funding: Funding | null;
  readonly chain: Chain;
  readonly store: Store;
  private ipLimiter: RateLimiter;
  /** Quotes do on-chain reads: their own per-IP budget, so they can't be used to exhaust the RPC (audit 2026-10-06). */
  private quoteLimiter = new RateLimiter(60);
  private signerLimiter: RateLimiter;
  private queue: Promise<unknown> = Promise.resolve();
  private nextNonce = 0;
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private lastRebroadcast = new Map<string, number>();
  private alertedStuck = new Set<string>();
  readonly policy: ComplianceProvider;

  constructor(cfg: RelayerConfig, opts: { store?: Store; chain?: Chain; now?: () => number } = {}) {
    this.cfg = cfg;
    this.funding = cfg.funding ? new Funding(cfg.funding) : null;
    this.chain = opts.chain ?? connect(cfg);
    this.store = opts.store ?? new Store(cfg.dbPath);
    this.now = opts.now ?? Date.now;
    this.ipLimiter = new RateLimiter(cfg.perIpPerMinute);
    this.signerLimiter = new RateLimiter(cfg.perSignerPerMinute);
    this.policy = new LocalRulesPolicy(cfg.policy);
  }

  /** Where a method's transaction goes: fixed by config, never by the client. */
  private targetOf(m: Method) {
    return AUTOMATE_METHODS.includes(m) ? this.cfg.automate! : EARN_USDC_METHODS.includes(m) ? this.cfg.earnUsdc! : isEarn(m) ? this.cfg.earn! : isPay(m) ? this.cfg.pay! : isPayV2(m) ? this.cfg.payV2! : this.cfg.escrow;
  }

  private now: () => number;

  get address() {
    return this.chain.account.address;
  }

  async start(): Promise<void> {
    await startupChecks(this.cfg, this.chain);
    await this.syncNonce();
    this.timer = setInterval(() => void this.tick(), this.cfg.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.queue.catch(() => {});
  }

  /** Monad "pending" == "latest" (no global mempool); never go below our own highest in-flight nonce + 1. */
  private async syncNonce(): Promise<void> {
    const onChain = await this.chain.client.getTransactionCount({ address: this.address, blockTag: "pending" });
    const local = this.store.maxNonce();
    this.nextNonce = Math.max(onChain, local === null ? 0 : local + 1);
  }

  // -----------------------------------------------------------------------------------------------
  // Intake pipeline: validate → precheck → rate-limit → idempotency → balance/budget → simulate → submit
  // -----------------------------------------------------------------------------------------------

  async submitAction(method: string, body: unknown, ip: string): Promise<ApiResult> {
    const now = this.now();
    if (!(METHODS as readonly string[]).includes(method)) return { httpStatus: 404, body: { error: "UnknownMethod" } };
    if (!this.ipLimiter.allow(`ip:${ip}`, now)) return { httpStatus: 429, body: { error: "RateLimited" } };

    let prep;
    try {
      prep = await prepare(method as Method, body, this.cfg, this.chain);
    } catch (e) {
      if (e instanceof ValidationError) return { httpStatus: 400, body: { error: "InvalidRequest", detail: e.message } };
      if (e instanceof PrecheckError) return { httpStatus: e.httpStatus, body: { error: e.code } };
      log("error", "relayer.precheck_rpc_error", { method, err: String(e) });
      return { httpStatus: 503, body: { error: "UpstreamUnavailable" } };
    }

    // Idempotency first: a retry of an already-accepted action must not be rate limited or re-simulated.
    const existing = this.store.findLive(prep.idemKey);
    if (existing) return { httpStatus: 200, body: { ...publicView(existing), idempotent: true } };

    if (prep.signer) {
      if (!this.signerLimiter.allow(`signer:${prep.signer}`, now)) return { httpStatus: 429, body: { error: "RateLimited" } };
      if (this.store.countSignerSince(prep.signer, dayStart(now)) >= this.cfg.perSignerPerDay) {
        return { httpStatus: 429, body: { error: "DailyLimitReached" } };
      }
    }

    // Policy before anything is queued or simulated. Fail closed; every decision is recorded.
    if (prep.money) {
      const m = prep.money;
      let agoraWhitelisted: boolean | null = null;
      if (m.route === "AGORA_INSTANT_SETTLEMENT") {
        const pair = tokenFor(this.chain.chainId, m.sourceToken)?.pair;
        agoraWhitelisted = pair
          ? await this.chain.client.readContract({ address: pair, abi: agoraPairAbi, functionName: "hasRole", args: ["APPROVED_SWAPPER", this.cfg.pay!] }).catch(() => null)
          : false;
      }
      const verdict = await decide(this.policy, {
        chainId: this.chain.chainId, sender: m.sender, recipient: m.recipient, amount: m.amount, sourceToken: m.sourceToken,
        route: m.route, mode: m.mode, sentToday: this.store.allowedVolumeSince(m.sender, dayStart(now)), agoraWhitelisted,
        kyc: "NOT_REQUIRED",
      });
      this.store.recordDecision({ paymentId: prep.paymentId, method: prep.method, sender: m.sender, recipient: m.recipient, amount: m.amount,
        sourceToken: m.sourceToken, route: m.route, decision: verdict.decision, reasons: verdict.reasons, ruleVersion: verdict.ruleVersion, provider: verdict.provider }, now);
      log("info", "policy.decision", { paymentId: prep.paymentId, method: prep.method, decision: verdict.decision, reasons: verdict.reasons.join(","), rule: verdict.ruleVersion });
      if (verdict.decision === "DENY") return { httpStatus: 403, body: { error: "POLICY_DENIED", reasons: verdict.reasons } };
      if (verdict.decision === "REVIEW") return { httpStatus: 409, body: { error: "POLICY_REVIEW", reasons: verdict.reasons } };
    }

    const gasLimit = this.cfg.gasLimits[prep.method];
    // Synchronous claim of the idempotency key (no await between findLive and insert).
    const row = this.store.insert({
      idem_key: prep.idemKey, method: prep.method, signer: prep.signer, payment_id: prep.paymentId,
      calldata: prep.data, gas_limit: gasLimit.toString(), ip,
    });

    const reject = (httpStatus: number, error: string, extra: Record<string, unknown> = {}): ApiResult => {
      this.store.update(row.id, { status: "REJECTED", error });
      return { httpStatus, body: { ...publicView(this.store.get(row.id)!), ...extra } };
    };

    try {
      const balance = await this.chain.client.getBalance({ address: this.address });
      if (balance < this.cfg.minRelayerBalanceWei) {
        log("alert", "relayer.low_balance", { balanceWei: balance, minWei: this.cfg.minRelayerBalanceWei });
        return reject(503, "RelayerUnavailable");
      }
    } catch (e) {
      log("error", "relayer.balance_rpc_error", { err: String(e) });
      return reject(503, "UpstreamUnavailable");
    }

    const day = utcDay(now);
    if (!this.store.reserveGas(day, gasLimit, this.cfg.dailyGasBudget)) {
      log("alert", "relayer.daily_gas_budget_exhausted", { day });
      return reject(503, "DailyBudgetExhausted");
    }

    // Known-revert filtering: never pay for a transaction that simulation says will revert.
    try {
      await this.chain.client.simulateContract({
        address: prep.target,
        abi: AUTOMATE_METHODS.includes(prep.method) ? everpieceAutomateAbi : isEarn(prep.method) ? earnRelayAbi : isPay(prep.method) ? payRelayAbi : isPayV2(prep.method) ? payV2RelayAbi : relayAbi,
        functionName: prep.fn ?? prep.method,
        args: prep.args,
        account: this.address,
        gas: gasLimit,
        blockTag: "latest",
      } as Parameters<typeof this.chain.client.simulateContract>[0]);
    } catch (e) {
      this.store.releaseGas(day, gasLimit);
      const reason = revertName(e);
      if (reason) return reject(422, reason);
      log("error", "relayer.simulation_rpc_error", { method: prep.method, err: String(e) });
      return reject(503, "UpstreamUnavailable");
    }

    await this.enqueueBroadcast(row.id, day);
    const after = this.store.get(row.id)!;
    return { httpStatus: after.status === "FAILED" ? 503 : 202, body: publicView(after) };
  }

  getRequest(id: string): RequestRow | undefined {
    return this.store.get(id);
  }

  // -----------------------------------------------------------------------------------------------
  // Serialized broadcast (one nonce sequence per relayer EOA — master §26.6)
  // -----------------------------------------------------------------------------------------------

  private enqueueBroadcast(id: string, day: string): Promise<void> {
    const p = this.queue.then(() => this.broadcast(id, day, false));
    this.queue = p.catch(() => {});
    return p;
  }

  private async fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const block = await this.chain.client.getBlock({ blockTag: "latest" });
    const base = block.baseFeePerGas ?? 0n;
    const tip = this.cfg.priorityFeeWei;
    if (base + tip > this.cfg.maxFeePerGasWei) throw new Error(`base fee ${base} + tip exceeds MAX_FEE_PER_GAS_WEI`);
    const want = base * 2n + tip;
    return { maxFeePerGas: want > this.cfg.maxFeePerGasWei ? this.cfg.maxFeePerGasWei : want, maxPriorityFeePerGas: tip };
  }

  private async broadcast(id: string, day: string, retried: boolean): Promise<void> {
    const row = this.store.get(id)!;
    const nonce = this.nextNonce;
    let raw: Hex;
    try {
      const fees = await this.fees();
      raw = await this.chain.account.signTransaction({
        type: "eip1559",
        chainId: this.chain.chainId,
        to: this.targetOf(row.method), // fixed per method by config; calldata was built server-side from the allow-listed ABI
        data: row.calldata as Hex,
        value: 0n,
        gas: BigInt(row.gas_limit),
        nonce,
        ...fees,
      });
    } catch (e) {
      this.store.releaseGas(day, BigInt(row.gas_limit));
      this.store.update(id, { status: "FAILED", error: "BroadcastPreparationFailed" });
      log("error", "relayer.sign_failed", { id, err: String(e) });
      return;
    }
    const hash = keccak256(raw);
    // Persist before sending so a crash can rebroadcast the exact same transaction.
    this.store.update(id, { status: "PROCESSING", tx_hash: hash, nonce, raw_tx: raw, submitted_at: this.now() });
    this.nextNonce = nonce + 1;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.chain.client.sendRawTransaction({ serializedTransaction: raw });
        log("info", "relayer.broadcast", { id, method: row.method, hash, nonce });
        return;
      } catch (e) {
        const msg = String(e);
        if (/already known|already imported|known transaction/i.test(msg)) return;
        if (!retried && /nonce too low|nonce.*(used|low)|replacement/i.test(msg)) {
          await this.syncNonce();
          this.store.update(id, { status: "SUBMITTED", tx_hash: null, nonce: null, raw_tx: null });
          return this.broadcast(id, day, true);
        }
        if (isTransientRpcError(e)) {
          // Rate limit, 5xx, timeout or dropped connection: the node may or may not have the transaction, so it is
          // NOT a rejection. Retry briefly; then keep the exact signed transaction PROCESSING (nonce stays consumed):
          // the monitor rebroadcasts it and reconciles from the receipt, and alerts if it's stuck.
          if (attempt < BROADCAST_RETRIES) {
            await new Promise((r) => setTimeout(r, 500 * 3 ** attempt));
            continue;
          }
          log("warn", "relayer.broadcast_deferred", { id, hash, nonce, err: msg.slice(0, 200) });
          return;
        }
        // Definitive rejection by the node: the nonce slot was not consumed.
        this.nextNonce = nonce;
        this.store.releaseGas(day, BigInt(row.gas_limit));
        this.store.update(id, { status: "FAILED", error: "BroadcastRejected", tx_hash: null, raw_tx: null, nonce: null });
        log("error", "relayer.broadcast_rejected", { id, err: msg.slice(0, 300) });
        return;
      }
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Monitor: inclusion is NOT success (ESCROW_SPEC §17, VERIFIED §1.14)
  // -----------------------------------------------------------------------------------------------

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const rows = this.store.byStatus("PROCESSING");
      if (rows.length === 0) return;
      const finalized = (await this.chain.client.getBlock({ blockTag: "finalized" })).number;
      for (const r of rows) await this.reconcile(r, finalized);
    } catch (e) {
      log("warn", "relayer.monitor_error", { err: String(e) });
    } finally {
      this.ticking = false;
    }
  }

  private async reconcile(r: RequestRow, finalized: bigint): Promise<void> {
    const now = this.now();
    const receipt = await this.chain.client.getTransactionReceipt({ hash: r.tx_hash as Hex }).catch(() => null);
    if (!receipt) {
      const age = now - (r.submitted_at ?? now);
      const last = this.lastRebroadcast.get(r.id) ?? 0;
      if (age > this.cfg.rebroadcastAfterMs && now - last > this.cfg.rebroadcastAfterMs && r.raw_tx) {
        this.lastRebroadcast.set(r.id, now);
        await this.chain.client.sendRawTransaction({ serializedTransaction: r.raw_tx as Hex }).catch(() => {});
        log("warn", "relayer.rebroadcast", { id: r.id, hash: r.tx_hash });
      }
      if (age > this.cfg.stuckAfterMs && !this.alertedStuck.has(r.id)) {
        this.alertedStuck.add(r.id);
        log("alert", "relayer.stuck_transaction", { id: r.id, hash: r.tx_hash, nonce: r.nonce });
      }
      return;
    }
    if (r.included_block !== receipt.blockNumber.toString()) this.store.update(r.id, { included_block: receipt.blockNumber.toString() });
    if (receipt.blockNumber > finalized) return; // included, maybe executed speculatively — not final yet

    if (isPay(r.method)) return this.reconcileSettleOnce(r, receipt, this.cfg.pay!, everpiecePayAbi, "Paid");
    if (AUTOMATE_METHODS.includes(r.method as Method)) return this.reconcileAutomate(r, receipt);
    if (isPayV2(r.method)) return this.reconcileSettleOnce(r, receipt, this.cfg.payV2!, everpiecePayV2Abi, "Paid");
    if (isEarn(r.method)) return this.reconcileSettleOnce(r, receipt, this.targetOf(r.method), everpieceEarnAbi, EXPECTED[r.method].event as "EarnDeposited" | "EarnWithdrawn");
    const payment = await readPayment(this.cfg, this.chain, r.payment_id as Hex, "finalized");
    const chainStatus = Number(payment.status);
    const gasUsed = receipt.gasUsed.toString();

    if (receipt.status !== "success") {
      this.store.update(r.id, { status: "FAILED", error: "RevertedOnChain", gas_used: gasUsed, chain_status: chainStatus });
      log("warn", "relayer.reverted_on_chain", { id: r.id, hash: r.tx_hash, chainStatus });
      return;
    }

    const expected = EXPECTED[r.method];
    const events = parseEventLogs({
      abi: everpieceEscrowAbi,
      logs: receipt.logs.filter((l) => l.address.toLowerCase() === this.cfg.escrow.toLowerCase()),
      eventName: expected.event as Exclude<EscrowEvent, "Paid" | "EarnDeposited" | "EarnWithdrawn" | "GrantActivated" | "GrantRevoked" | "Executed">,
    }) as unknown as { args: { paymentId: Hex } }[];
    const eventOk = events.some((ev) => ev.args.paymentId.toLowerCase() === r.payment_id.toLowerCase());
    // create: the payment may already have moved on by finality (claimed/cancelled) — it must at least exist.
    const stateOk = r.method === "createPayment" ? chainStatus !== PaymentStatus.NONE : chainStatus === expected.status;

    if (eventOk && stateOk) {
      this.store.update(r.id, { status: "CONFIRMED", error: null, gas_used: gasUsed, chain_status: chainStatus });
      log("info", "relayer.confirmed", { id: r.id, method: r.method, hash: r.tx_hash, block: receipt.blockNumber, gasUsed });
    } else {
      this.store.update(r.id, { status: "FAILED", error: "ExpectedEventOrStateMissing", gas_used: gasUsed, chain_status: chainStatus });
      log("alert", "relayer.unexpected_outcome", { id: r.id, eventOk, stateOk, chainStatus });
    }
  }

  /**
   * Settle-once contracts (EverpiecePay, EverpieceEarn): CONFIRMED only with receipt status 1, the expected event for
   * this id from that contract, and settled(id) at "finalized".
   */
  /** EverpieceAutomate: the expected event for this id AND the matching state at "finalized". */
  private async reconcileAutomate(r: RequestRow, receipt: Awaited<ReturnType<typeof this.chain.client.getTransactionReceipt>>): Promise<void> {
    const contract = this.cfg.automate!;
    const gasUsed = receipt.gasUsed.toString();
    const id = r.payment_id as Hex;
    let stateOk = false;
    if (r.method === "automateExecute") {
      stateOk = (await this.chain.client.readContract({ address: contract, abi: everpieceAutomateAbi, functionName: "executed", args: [id], blockTag: "finalized" })) as boolean;
    } else {
      const st = (await this.chain.client.readContract({ address: contract, abi: everpieceAutomateAbi, functionName: "grants", args: [id], blockTag: "finalized" })) as readonly unknown[];
      stateOk = r.method === "automateActivate" ? !/^0x0{40}$/i.test(st[0] as string) : st[8] === true;
    }
    if (receipt.status !== "success") {
      this.store.update(r.id, { status: "FAILED", error: "RevertedOnChain", gas_used: gasUsed, chain_status: stateOk ? 1 : 0 });
      return;
    }
    const eventName = EXPECTED[r.method as Method].event;
    const events = parseEventLogs({ abi: everpieceAutomateAbi, logs: receipt.logs.filter((l) => l.address.toLowerCase() === contract.toLowerCase()), eventName } as Parameters<typeof parseEventLogs>[0]) as unknown as { args: { grantId?: Hex; executionId?: Hex } }[];
    const eventOk = events.some((ev) => ((r.method === "automateExecute" ? ev.args.executionId : ev.args.grantId) ?? "0x").toLowerCase() === id.toLowerCase());
    if (eventOk && stateOk) {
      this.store.update(r.id, { status: "CONFIRMED", error: null, gas_used: gasUsed, chain_status: 1 });
      log("info", "relayer.confirmed", { id: r.id, method: r.method, hash: r.tx_hash, block: receipt.blockNumber, gasUsed });
    } else {
      this.store.update(r.id, { status: "FAILED", error: "ExpectedEventOrStateMissing", gas_used: gasUsed, chain_status: stateOk ? 1 : 0 });
      log("alert", "relayer.unexpected_outcome", { id: r.id, eventOk, stateOk });
    }
  }

  private async reconcileSettleOnce(
    r: RequestRow,
    receipt: Awaited<ReturnType<typeof this.chain.client.getTransactionReceipt>>,
    contract: Hex,
    abi: typeof everpiecePayAbi | typeof everpiecePayV2Abi | typeof everpieceEarnAbi,
    eventName: "Paid" | "EarnDeposited" | "EarnWithdrawn",
  ): Promise<void> {
    const gasUsed = receipt.gasUsed.toString();
    const settled = (await this.chain.client.readContract({
      address: contract, abi, functionName: "settled", args: [r.payment_id as Hex], blockTag: "finalized",
    } as Parameters<typeof this.chain.client.readContract>[0])) as boolean;
    if (receipt.status !== "success") {
      this.store.update(r.id, { status: "FAILED", error: "RevertedOnChain", gas_used: gasUsed, chain_status: settled ? 1 : 0 });
      log("warn", "relayer.reverted_on_chain", { id: r.id, hash: r.tx_hash });
      return;
    }
    const events = parseEventLogs({
      abi,
      logs: receipt.logs.filter((l) => l.address.toLowerCase() === contract.toLowerCase()),
      eventName,
    } as Parameters<typeof parseEventLogs>[0]) as unknown as { args: { paymentId?: Hex; id?: Hex } }[];
    const eventOk = events.some((ev) => (ev.args.paymentId ?? ev.args.id ?? "0x").toLowerCase() === r.payment_id.toLowerCase());
    if (eventOk && settled) {
      this.store.update(r.id, { status: "CONFIRMED", error: null, gas_used: gasUsed, chain_status: 1 });
      log("info", "relayer.confirmed", { id: r.id, method: r.method, hash: r.tx_hash, block: receipt.blockNumber, gasUsed });
    } else {
      this.store.update(r.id, { status: "FAILED", error: "ExpectedEventOrStateMissing", gas_used: gasUsed, chain_status: settled ? 1 : 0 });
      log("alert", "relayer.unexpected_outcome", { id: r.id, eventOk, settled });
    }
  }

  /**
   * Route quote (owner mandate §13): which provider can deliver EXACTLY `buyAmount` AUSD to `recipient` from `sellToken`.
   * DIRECT_AUSD: sell = buy. AGORA_INSTANT_SETTLEMENT: the pair's own getAmountsIn via EverpiecePay.quote (fees included),
   * plus headroom the payer authorizes as a ceiling; the contract returns whatever the swap didn't use. Anything else:
   * UNSUPPORTED_TOKEN (never a fake quote). 0x has no Monad testnet support (docs/ROUTING.md), so it never quotes here.
   */
  async quote(body: unknown, ip = "unknown"): Promise<ApiResult> {
    if (!this.quoteLimiter.allow(`quote:${ip}`, this.now())) return { httpStatus: 429, body: { error: "RateLimited" } };
    let q;
    try {
      q = parseQuote(body);
    } catch (e) {
      return { httpStatus: 400, body: { error: "InvalidRequest", detail: (e as Error).message } };
    }
    if (!this.cfg.pay) return { httpStatus: 503, body: { error: "PROVIDER_UNAVAILABLE" } };
    const token = tokenFor(this.chain.chainId, q.sellToken);
    if (!token) return { httpStatus: 422, body: { error: "UNSUPPORTED_TOKEN" } };
    if (q.buyAmount < this.cfg.minPaymentAmount) return { httpStatus: 422, body: { error: "BelowMinimumPayment" } };
    const base = { quoteId: randomUUID(), environment: (token.testnet ? "testnet" : "mainnet") as "testnet" | "mainnet", chainId: this.chain.chainId, sellToken: token.address,
      sellTokenDecimals: token.decimals, buyToken: this.cfg.ausd, buyAmount: q.buyAmount, networkFee: 0n,
      expiresAt: Math.floor(this.now() / 1000) + this.cfg.quoteTtlSec, recipient: q.recipient, simulated: false as const };
    if (token.route === "DIRECT_AUSD") {
      const quote: RouteQuote = { ...base, provider: "DIRECT_AUSD", sellAmount: q.buyAmount, maxSellAmount: q.buyAmount, providerFee: 0n };
      return { httpStatus: 200, body: { quote } };
    }
    if (token.route !== "AGORA_INSTANT_SETTLEMENT" || !token.pair) return { httpStatus: 422, body: { error: "NO_ROUTE" } };
    try {
      const whitelisted = await this.chain.client.readContract({ address: token.pair, abi: agoraPairAbi, functionName: "hasRole", args: ["APPROVED_SWAPPER", this.cfg.pay] });
      if (!whitelisted) return { httpStatus: 503, body: { error: "AGORA_NOT_WHITELISTED" } };
      const sellAmount = await this.chain.client.readContract({ address: this.cfg.pay, abi: everpiecePayAbi, functionName: "quote", args: [token.address, q.buyAmount] });
      const maxSellAmount = sellAmount + (sellAmount * this.cfg.quoteHeadroomBps + 9_999n) / 10_000n;
      // Agora fees are inside getAmountsIn; reported here as the difference from a 1:1 conversion of decimals.
      const parity = q.buyAmount * 10n ** BigInt(token.decimals - 6);
      const quote: RouteQuote = { ...base, provider: "AGORA_INSTANT_SETTLEMENT", sellAmount, maxSellAmount, providerFee: sellAmount > parity ? sellAmount - parity : 0n };
      return { httpStatus: 200, body: { quote } };
    } catch (e) {
      const reason = revertName(e);
      log("warn", "quote.failed", { err: String(e).slice(0, 200) });
      return { httpStatus: reason ? 422 : 503, body: { error: reason ? "NO_ROUTE" : "PROVIDER_UNAVAILABLE" } };
    }
  }

  /**
   * EverpiecePayV2 quote: what the payer must authorize so the recipient receives EXACTLY `amount` of `asset`.
   * DIRECT: the same amount. CONVERTED: live quotes from each provider the contract would try, in its order (Agora only
   * while approved, then the fixed Uniswap v4 pool through Uniswap's own Quoter); maxSourceAmount covers whichever
   * executes (unused input is refunded on-chain) and never exceeds the relayer's slippage cap. No provider → available
   * false: the app offers the truthful fallback (deliver the source asset) or a direct payment, never a fake quote.
   */
  async quoteV2(body: unknown, ip = "unknown"): Promise<ApiResult> {
    if (!this.quoteLimiter.allow(`quote:${ip}`, this.now())) return { httpStatus: 429, body: { error: "RateLimited" } };
    let q;
    try {
      q = parseQuoteV2(body);
    } catch (e) {
      return { httpStatus: 400, body: { error: "InvalidRequest", detail: (e as Error).message } };
    }
    if (!this.cfg.payV2) return { httpStatus: 503, body: { error: "PROVIDER_UNAVAILABLE" } };
    const chainId = this.chain.chainId;
    if (!settlementAsset(chainId, q.asset)) return { httpStatus: 422, body: { error: "UNSUPPORTED_ASSET" } };
    if (!settlementAsset(chainId, q.sourceToken)) return { httpStatus: 422, body: { error: "UNSUPPORTED_ROUTE" } };
    if (q.amount < this.cfg.minPaymentAmount) return { httpStatus: 422, body: { error: "BelowMinimumPayment" } };
    const expiresAt = Math.floor(this.now() / 1000) + this.cfg.quoteTtlSec;
    const base = { quoteId: randomUUID(), chainId, asset: q.asset, amount: q.amount, sourceToken: q.sourceToken, expiresAt };
    if (routeOf(q.asset, q.sourceToken) === "DIRECT") {
      return { httpStatus: 200, body: { quote: { ...base, route: "DIRECT", available: true, provider: null, sourceAmount: q.amount, maxSourceAmount: q.amount, providers: [] } } };
    }
    const providers: ConversionQuote[] = [];
    try {
      const [ok, need] = (await this.chain.client.readContract({ address: this.cfg.payV2, abi: everpiecePayV2Abi, functionName: "quote", args: [q.sourceToken, q.asset, q.amount] })) as readonly [boolean, bigint, string];
      providers.push(ok ? { provider: "AGORA", available: true, sourceAmount: need } : { provider: "AGORA", available: false, sourceAmount: null, reason: "NOT_APPROVED_OR_NO_QUOTE" });
    } catch (e) {
      providers.push({ provider: "AGORA", available: false, sourceAmount: null, reason: "PROVIDER_UNAVAILABLE" });
      log("warn", "quoteV2.agora_failed", { err: String(e).slice(0, 200) });
    }
    const converter = (await this.chain.client.readContract({ address: this.cfg.payV2, abi: everpiecePayV2Abi, functionName: "CONVERTER" }).catch(() => null)) as string | null;
    if (converter && !/^0x0{40}$/i.test(converter) && chainId === 143) {
      try {
        const zeroForOne = q.sourceToken.toLowerCase() === AUSD_USDC_V4_POOL.currency0.toLowerCase();
        const { result } = await this.chain.client.simulateContract({
          address: UNISWAP_V4_MONAD.quoter, abi: v4QuoterAbi, functionName: "quoteExactOutputSingle",
          args: [{ poolKey: { currency0: AUSD_USDC_V4_POOL.currency0, currency1: AUSD_USDC_V4_POOL.currency1, fee: AUSD_USDC_V4_POOL.fee, tickSpacing: AUSD_USDC_V4_POOL.tickSpacing, hooks: AUSD_USDC_V4_POOL.hooks }, zeroForOne, exactAmount: q.amount, hookData: "0x" }],
        });
        providers.push({ provider: "UNISWAP_V4", available: true, sourceAmount: result[0] });
      } catch (e) {
        providers.push({ provider: "UNISWAP_V4", available: false, sourceAmount: null, reason: "INSUFFICIENT_LIQUIDITY_OR_UNAVAILABLE" });
        log("warn", "quoteV2.v4_failed", { err: String(e).slice(0, 200) });
      }
    } else {
      providers.push({ provider: "UNISWAP_V4", available: false, sourceAmount: null, reason: "NOT_CONFIGURED" });
    }
    const live = providers.filter((p) => p.available && p.sourceAmount !== null);
    const cap = (q.amount * (10_000n + this.cfg.maxConvertSlippageBps)) / 10_000n;
    if (live.length === 0) {
      return { httpStatus: 200, body: { quote: { ...base, route: "CONVERTED", available: false, provider: null, sourceAmount: null, maxSourceAmount: null, fallbackMaxSourceAmount: q.amount, providers } } };
    }
    // the contract tries Agora first when approved, so the expected provider is the first live one in that order
    const expected = live[0];
    const worst = live.reduce((m, p) => (p.sourceAmount! > m ? p.sourceAmount! : m), 0n);
    let maxSourceAmount = worst + (worst * this.cfg.quoteHeadroomBps + 9_999n) / 10_000n;
    if (maxSourceAmount > cap) maxSourceAmount = cap;
    if (maxSourceAmount < expected.sourceAmount!) {
      return { httpStatus: 200, body: { quote: { ...base, route: "CONVERTED", available: false, provider: null, sourceAmount: null, maxSourceAmount: null, fallbackMaxSourceAmount: q.amount, providers, reason: "PRICE_ABOVE_SLIPPAGE_CAP" } } };
    }
    return { httpStatus: 200, body: { quote: { ...base, route: "CONVERTED", available: true, provider: expected.provider, sourceAmount: expected.sourceAmount, maxSourceAmount, providers } } };
  }

  async health(): Promise<Record<string, unknown>> {
    const [chainId, balance, latest] = await Promise.all([
      this.chain.client.getChainId(),
      this.chain.client.getBalance({ address: this.address }),
      this.chain.client.getBlockNumber(),
    ]);
    return {
      ok: chainId === this.cfg.expectedChainId && balance >= this.cfg.minRelayerBalanceWei,
      chainId,
      relayer: this.address,
      balanceWei: balance.toString(),
      belowMinBalance: balance < this.cfg.minRelayerBalanceWei,
      latestBlock: latest.toString(),
      processing: this.store.byStatus("PROCESSING").length,
    };
  }
}

const BROADCAST_RETRIES = 3; // waits 0.5 s, 1.5 s, 4.5 s

/**
 * Transport trouble, not a verdict on the transaction: HTTP 429 / 408 / 5xx, timeouts, dropped connections.
 * (Monad's public testnet RPC rate-limits eth_sendRawTransaction with 429.) A JSON-RPC error answer from the node
 * (invalid tx, insufficient funds, …) is a real rejection and is NOT transient.
 */
export function isTransientRpcError(e: unknown): boolean {
  const transient = (x: unknown) =>
    x instanceof TimeoutError ||
    (x instanceof HttpRequestError && (x.status === undefined || x.status === 408 || x.status === 429 || x.status >= 500));
  if (e instanceof BaseError) return Boolean(e.walk(transient));
  return /fetch failed|ECONNRESET|ECONNREFUSED|socket hang up|ETIMEDOUT/i.test(String(e));
}

/** Decoded custom-error name of a simulated revert, or null when the failure was not a revert (RPC/transport). */
export function revertName(e: unknown): string | null {
  if (e instanceof BaseError) {
    const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      return reverted.data?.errorName ?? reverted.reason ?? "Reverted";
    }
  }
  return null;
}
