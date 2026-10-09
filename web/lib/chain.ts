import { createPublicClient, defineChain, http, type Address, type Hex } from "viem";
import { ausdAbi, everpieceEscrowAbi } from "@everpiece/shared";
import { config } from "./config";

export const chain = defineChain({
  id: config.chainId,
  name: "Monad",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
});

export const client = createPublicClient({ chain, transport: http(config.rpcUrl) });

export type Payment = {
  sender: Address;
  expiresAt: bigint;
  mode: number;
  status: number;
  amount: bigint;
  createdAt: bigint;
  approver: Address;
  recipientCommitment: Hex;
  metadataCommitment: Hex;
};

export async function dollarsOf(who: Address): Promise<bigint> {
  return client.readContract({ address: config.dollar.address, abi: ausdAbi, functionName: "balanceOf", args: [who] });
}

export async function paymentOf(paymentId: Hex): Promise<Payment> {
  return (await client.readContract({
    address: config.escrow,
    abi: everpieceEscrowAbi,
    functionName: "getPayment",
    args: [paymentId],
  })) as unknown as Payment;
}

export async function claimApprover(): Promise<Address> {
  return client.readContract({ address: config.escrow, abi: everpieceEscrowAbi, functionName: "claimApprover" });
}

export async function chainTime(): Promise<bigint> {
  return (await client.getBlock({ blockTag: "latest" })).timestamp;
}

/** Base units (6 dp) → "$12.34". Never uses floating point for value (master §39). */
export function formatDollars(units: bigint): string {
  const neg = units < 0n;
  const u = neg ? -units : units;
  const whole = u / 1_000_000n;
  const cents = (u % 1_000_000n) / 10_000n;
  return `${neg ? "-" : ""}$${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
}

/** "12.34" → 12_340_000n. Rejects more than 2 decimals, signs and exponents. */
export function parseDollars(input: string): bigint | null {
  const s = input.trim().replace(/^\$/, "");
  if (!/^(0|[1-9][0-9]{0,6})(\.[0-9]{1,2})?$/.test(s)) return null;
  const [w, f = ""] = s.split(".");
  return BigInt(w) * 1_000_000n + BigInt(f.padEnd(2, "0")) * 10_000n;
}
