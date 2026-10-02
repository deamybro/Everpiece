import { BaseError, ContractFunctionRevertedError, HttpRequestError, TimeoutError, keccak256, parseEventLogs, type Hex } from "viem";
import { everpieceEscrowAbi, PaymentStatus } from "@everpiece/shared";
import { METHODS, type Method, type RelayerConfig } from "./config.ts";
import { connect, readPayment, relayAbi, startupChecks, type Chain } from "./chain.ts";
import { prepare, PrecheckError, type EscrowEvent } from "./actions.ts";
import { Store, type RequestRow } from "./store.ts";
import { ValidationError } from "./validate.ts";
import { log } from "./log.ts";

export type ApiResult = { httpStatus: number; body: Record<string, unknown> };

const EXPECTED: Record<Method, { event: EscrowEvent; status: number }> = {
  createPayment: { event: "PaymentCreated", status: PaymentStatus.ACTIVE },
  claimUsernamePayment: { event: "PaymentClaimed", status: PaymentStatus.CLAIMED },
  claimLinkPayment: { event: "PaymentClaimed", status: PaymentStatus.CLAIMED },
  cancel: { event: "PaymentCancelled", status: PaymentStatus.CANCELLED },
  refundExpired: { event: "PaymentRefunded", status: PaymentStatus.REFUNDED },
};

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
  readonly chain: Chain;
  readonly store: Store;
  private ipLimiter: RateLimiter;
  private signerLimiter: RateLimiter;
  private queue: Promise<unknown> = Promise.resolve();
  private nextNonce = 0;
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private lastRebroadcast = new Map<string, number>();
  private alertedStuck = new Set<string>();

  constructor(cfg: RelayerConfig, opts: { store?: Store; chain?: Chain; now?: () => number } = {}) {
    this.cfg = cfg;
    this.chain = opts.chain ?? connect(cfg);
    this.store = opts.store ?? new Store(cfg.dbPath);
    this.now = opts.now ?? Date.now;
    this.ipLimiter = new RateLimiter(cfg.perIpPerMinute);
    this.signerLimiter = new RateLimiter(cfg.perSignerPerMinute);
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
        address: this.cfg.escrow,
        abi: relayAbi,
        functionName: prep.method,
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
        to: this.cfg.escrow, // fixed target; calldata was built server-side from the allow-listed ABI
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
      eventName: expected.event,
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
