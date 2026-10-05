// Integration harness: local anvil fork of Monad mainnet (network = monad) with the REAL AUSD contract,
// a freshly deployed EverpieceEscrow, and the relayer served over real HTTP.
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  parseEther,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  AUSD_ADDRESS,
  PaymentMode,
  cancelIntent,
  claimApproval,
  claimIntent,
  everpieceEscrowAbi,
  fundingAuthorization,
  linkClaimIntent,
  paymentIdOf,
  recipientCommitment,
  type PaymentIntent,
} from "@everpiece/shared";
import { Relayer, createHttpServer, setLogSink, type RelayerConfig } from "../src/index.ts";

export const RUN = process.env.RUN_FORK_TESTS === "true";
const FORK_URL = process.env.MONAD_RPC ?? "https://rpc.monad.xyz";
const CORE_SLOT = "0x455730fed596673e69db1907be2e521374ba893f1a04cc5f5dd931616cd6b700"; // AUSD Erc20CoreStorage (VERIFIED §2.12)

// Test-only keys (never used on a real chain).
const k = (n: number) => privateKeyToAccount(toHex(n, { size: 32 }));
export const keys = {
  deployer: k(0xd1),
  owner: k(0xd2),
  approver: k(0xa1),
  relayer: k(0xe1),
  sender: k(0x51),
  recipient: k(0x52),
  claimKey: k(0x53),
  stranger: k(0x54),
};

export type Env = {
  rpc: string;
  anvil: ChildProcess;
  escrow: Address;
  pub: ReturnType<typeof createPublicClient>;
  test: ReturnType<typeof createTestClient>;
  relayer: Relayer;
  server: Server;
  base: string;
  logs: string[];
  stop(): Promise<void>;
};

const chainFor = (rpc: string) =>
  defineChain({ id: 143, name: "monad-fork", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });

async function waitRpc(rpc: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("anvil did not start");
}

export function baseConfig(rpc: string, escrow: Address, over: Partial<RelayerConfig> = {}): RelayerConfig {
  return {
    rpcUrl: rpc,
    expectedChainId: 143,
    escrow,
    ausd: AUSD_ADDRESS,
    relayerPrivateKey: toHex(0xe1, { size: 32 }),
    port: 0,
    host: "127.0.0.1",
    dbPath: ":memory:",
    gasLimits: { createPayment: 350_000n, claimUsernamePayment: 215_000n, claimLinkPayment: 240_000n, cancel: 195_000n, refundExpired: 145_000n, payWithAusd: 200_000n, payWithToken: 420_000n },
    maxFeePerGasWei: parseEther("0.000001"), // 1000 gwei cap
    priorityFeeWei: 2_000_000_000n,
    minRelayerBalanceWei: parseEther("1"),
    dailyGasBudget: 50_000_000n,
    perIpPerMinute: 1_000,
    perSignerPerMinute: 1_000,
    perSignerPerDay: 1_000,
    minPaymentAmount: 1_000_000n,
    maxBodyBytes: 8_192,
    pollIntervalMs: 100,
    policy: { maxPerPayment: 500_000_000n, maxPerSenderPerDay: 100_000_000_000n, reviewAbove: 0n, denylist: new Set() },
    quoteHeadroomBps: 50n,
    quoteTtlSec: 60,
    rebroadcastAfterMs: 60_000,
    stuckAfterMs: 120_000,
    ...over,
  };
}

export async function startEnv(): Promise<Env> {
  const port = 18000 + Math.floor(Math.random() * 1500);
  const rpc = `http://127.0.0.1:${port}`;
  const anvil = spawn(process.env.ANVIL_BIN ?? "anvil", ["--network", "monad", "--fork-url", FORK_URL, "--port", String(port), "--silent"], { stdio: "ignore" });
  await waitRpc(rpc);
  const chain = chainFor(rpc);
  const pub = createPublicClient({ chain, transport: http(rpc) });
  const test = createTestClient({ chain, mode: "anvil", transport: http(rpc) });

  for (const a of [keys.deployer, keys.relayer]) await test.setBalance({ address: a.address, value: parseEther("100") });
  await setAusd(test, keys.sender.address, 10_000_000_000n);

  const artifact = JSON.parse(readFileSync(new URL("../../../contracts/out/EverpieceEscrow.sol/EverpieceEscrow.json", import.meta.url), "utf8"));
  const wallet = createWalletClient({ chain, transport: http(rpc), account: keys.deployer });
  const hash = await wallet.deployContract({ abi: everpieceEscrowAbi, bytecode: artifact.bytecode.object as Hex, args: [AUSD_ADDRESS, keys.owner.address, keys.approver.address] });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  const escrow = receipt.contractAddress!;

  const logs: string[] = [];
  setLogSink((l) => logs.push(l), "debug");
  const relayer = new Relayer(baseConfig(rpc, escrow));
  await relayer.start();
  const server = createHttpServer(relayer);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    rpc, anvil, escrow, pub, test, relayer, server, base, logs,
    async stop() {
      server.close();
      await relayer.stop();
      anvil.kill();
    },
  };
}

export async function setAusd(test: ReturnType<typeof createTestClient>, who: Address, amount: bigint): Promise<void> {
  const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [who, CORE_SLOT]));
  await test.setStorageAt({ address: AUSD_ADDRESS, index: slot, value: toHex(amount << 8n, { size: 32 }) });
}

export async function post(env: Env, path: string, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) {
  const r = await fetch(env.base + path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
}

export async function getReq(env: Env, id: string) {
  const r = await fetch(`${env.base}/v1/requests/${id}`);
  return (await r.json()) as Record<string, any>;
}

/** Mine past anvil's "finalized" (= latest − 64) and wait for the relayer's monitor to settle the request. */
export async function settle(env: Env, id: string, timeoutMs = 20_000): Promise<Record<string, any>> {
  await env.test.mine({ blocks: 66 });
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = await getReq(env, id);
    if (r.status === "CONFIRMED" || r.status === "FAILED") return r;
    if (Date.now() > until) throw new Error(`request ${id} still ${r.status}`);
    await new Promise((res) => setTimeout(res, 100));
  }
}

export async function now(env: Env): Promise<bigint> {
  return (await env.pub.getBlock({ blockTag: "latest" })).timestamp;
}

let saltCounter = 0n;
const rnd = (tag: string) => keccak256(toHex(`${tag}:${++saltCounter}:${Date.now()}`));

export async function usernameIntent(env: Env, amount = 25_000_000n, recipient: PrivateKeyAccount = keys.recipient) {
  const t = await now(env);
  const recipientSalt = rnd("rsalt");
  const intent: PaymentIntent = {
    sender: keys.sender.address,
    mode: PaymentMode.USERNAME,
    recipientCommitment: recipientCommitment(PaymentMode.USERNAME, recipient.address, recipientSalt),
    metadataCommitment: rnd("meta"),
    approver: "0x0000000000000000000000000000000000000000",
    amount,
    expiresAt: t + 2n * 86_400n,
    validAfter: 0n,
    validBefore: t + 3_600n,
    salt: rnd("salt"),
  };
  return { intent, recipientSalt, paymentId: paymentIdOf(env.escrow, intent) };
}

export async function linkIntent(env: Env, amount = 25_000_000n) {
  const t = await now(env);
  const recipientSalt = rnd("lsalt");
  const intent: PaymentIntent = {
    sender: keys.sender.address,
    mode: PaymentMode.LINK,
    recipientCommitment: recipientCommitment(PaymentMode.LINK, keys.claimKey.address, recipientSalt),
    metadataCommitment: rnd("meta"),
    approver: keys.approver.address,
    amount,
    expiresAt: t + 2n * 86_400n,
    validAfter: 0n,
    validBefore: t + 3_600n,
    salt: rnd("salt"),
  };
  return { intent, recipientSalt, paymentId: paymentIdOf(env.escrow, intent) };
}

export async function fundingSig(env: Env, intent: PaymentIntent, signer = keys.sender) {
  return signer.signTypedData(fundingAuthorization(env.escrow, intent));
}

export async function claimUsernameBody(env: Env, paymentId: Hex, recipientSalt: Hex, recipient = keys.recipient, signer = recipient) {
  const actionNonce = rnd("n");
  const deadline = (await now(env)) + 600n;
  const recipientSig = await signer.signTypedData(claimIntent(env.escrow, { paymentId, recipient: recipient.address, actionNonce, deadline }));
  return { paymentId, recipient: recipient.address, recipientSalt, actionNonce, deadline, recipientSig };
}

export async function claimLinkBody(env: Env, paymentId: Hex, recipientSalt: Hex, recipient = keys.recipient) {
  const actionNonce = rnd("n");
  const approvalNonce = rnd("a");
  const deadline = (await now(env)) + 600n;
  const claimKeySig = await keys.claimKey.signTypedData(linkClaimIntent(env.escrow, { paymentId, recipient: recipient.address, actionNonce, deadline }));
  const approverSig = await keys.approver.signTypedData(claimApproval(env.escrow, { paymentId, recipient: recipient.address, approvalNonce, deadline }));
  return {
    paymentId, recipient: recipient.address, claimKey: keys.claimKey.address, recipientSalt,
    actionNonce, deadline, claimKeySig, approvalNonce, approvalDeadline: deadline, approverSig,
  };
}

export async function cancelBody(env: Env, paymentId: Hex, signer = keys.sender) {
  const actionNonce = rnd("c");
  const deadline = (await now(env)) + 600n;
  const senderSig = await signer.signTypedData(cancelIntent(env.escrow, { paymentId, sender: keys.sender.address, actionNonce, deadline }));
  return { paymentId, actionNonce, deadline, senderSig };
}

export async function relayerNonce(env: Env): Promise<number> {
  return env.pub.getTransactionCount({ address: keys.relayer.address, blockTag: "pending" });
}

export async function ausdBalance(env: Env, who: Address): Promise<bigint> {
  return env.pub.readContract({
    address: AUSD_ADDRESS,
    abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
    functionName: "balanceOf",
    args: [who],
  }) as Promise<bigint>;
}
