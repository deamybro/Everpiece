import { createPublicClient, defineChain, getAddress, http, type Address, type PublicClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { ausdAbi, everpieceEscrowAbi } from "@everpiece/shared";
import type { RelayerConfig } from "./config.ts";
import { log } from "./log.ts";

/** Escrow ABI + AUSD custom errors, so simulations decode both escrow and token reverts by name. */
export const relayAbi = [...everpieceEscrowAbi, ...ausdAbi.filter((x) => x.type === "error")] as const;

export type Payment = {
  sender: Address;
  expiresAt: bigint;
  mode: number;
  status: number;
  amount: bigint;
  createdAt: bigint;
  approver: Address;
  recipientCommitment: `0x${string}`;
  metadataCommitment: `0x${string}`;
};

export type Chain = {
  client: PublicClient;
  account: PrivateKeyAccount;
  chainId: number;
};

export function connect(cfg: RelayerConfig): Chain {
  const chain = defineChain({
    id: cfg.expectedChainId,
    name: `monad-${cfg.expectedChainId}`,
    nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
  const client = createPublicClient({ chain, transport: http(cfg.rpcUrl, { retryCount: 2, timeout: 10_000 }) }) as PublicClient;
  return { client, account: privateKeyToAccount(cfg.relayerPrivateKey), chainId: cfg.expectedChainId };
}

/** Never broadcast to an unexpected network or contract (master §27). Throws on any mismatch. */
export async function startupChecks(cfg: RelayerConfig, c: Chain): Promise<void> {
  const chainId = await c.client.getChainId();
  if (chainId !== cfg.expectedChainId) throw new Error(`startup: RPC chainId ${chainId} != expected ${cfg.expectedChainId}`);
  const [escrowCode, ausdCode] = await Promise.all([
    c.client.getCode({ address: cfg.escrow }),
    c.client.getCode({ address: cfg.ausd }),
  ]);
  if (!escrowCode || escrowCode === "0x") throw new Error("startup: no code at ESCROW_ADDRESS");
  if (!ausdCode || ausdCode === "0x") throw new Error("startup: no code at AUSD_ADDRESS");
  const token = await c.client.readContract({ address: cfg.escrow, abi: everpieceEscrowAbi, functionName: "AUSD" });
  if (getAddress(token) !== cfg.ausd) throw new Error(`startup: escrow.AUSD() ${token} != ${cfg.ausd}`);
  const balance = await c.client.getBalance({ address: c.account.address });
  log("info", "relayer.startup", { chainId, escrow: cfg.escrow, relayer: c.account.address, balanceWei: balance });
  if (balance < cfg.minRelayerBalanceWei) log("alert", "relayer.low_balance", { balanceWei: balance, minWei: cfg.minRelayerBalanceWei });
}

export async function readPayment(
  cfg: RelayerConfig,
  c: Chain,
  paymentId: `0x${string}`,
  blockTag: "latest" | "finalized" = "latest",
): Promise<Payment> {
  const p = await c.client.readContract({
    address: cfg.escrow,
    abi: everpieceEscrowAbi,
    functionName: "getPayment",
    args: [paymentId],
    blockTag,
  });
  return p as unknown as Payment;
}
