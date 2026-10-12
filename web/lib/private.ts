import { createWalletClient, http, type Address, type Hash } from "viem";
import {
  Client,
  NotCompliantError,
  UserGroupAmountLimitError,
  UserGroupTransactionLimitError,
  InsufficientBalanceError,
  ActionTimeoutError,
  AlreadyRegisteredInDifferentGroupError,
  deriveAuthSecret,
  fetchComplianceData,
  isRegistered,
  register,
} from "@taceo/merces-client";
import { TACEO_MERCES_MONAD as T, privateAmountProblem } from "@everpiece/shared";
import { config, flags } from "./config";
import { chain, client } from "./chain";
import { withSigner, type Account } from "./mera";
import { PayError } from "./pay";

/**
 * Private Balance / Private Send (TACEO Merces on Monad mainnet). Optional, limited by the network itself: 1 USDC per
 * action, 35 actions per epoch, 100 members, compliance attestation for moving USDC in or out. Merces has no relayer,
 * so the user's own account submits each action and pays a little MON for gas. The spending credential (auth secret)
 * is derived from the passkey-held key on this device for each action and never stored or sent to Everpiece.
 */

/** TACEO's servers send no CORS headers, so the browser reaches them through our own origin (Caddy forwards, POST only). */
const taceoUrls = () => ({
  nodeUrls: [0, 1, 2].map((i) => `${window.location.origin}/svc/taceo/n${i}`),
  complianceUrl: `${window.location.origin}/svc/taceo/compliance/`,
});

export const privateAvailable = () => flags.PRIVATE_PAYMENTS_ENABLED && config.chainId === T.chainId;

export type PrivateStatus = { registered: boolean; mon: bigint; usdc: bigint };

export async function privateStatus(who: Address): Promise<PrivateStatus> {
  const [registered, mon, usdc] = await Promise.all([
    isRegistered({ publicClient: client, idRegistryAddress: T.idRegistry, address: who }),
    client.getBalance({ address: who }),
    client.readContract({ address: T.token, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const, functionName: "balanceOf", args: [who] }),
  ]);
  return { registered, mon, usdc };
}

/** Run one Merces action with this device's passkey-held key (one prompt). */
async function withMerces<R>(account: Account, fn: (c: Client, wallet: ReturnType<typeof walletFor>, authSecret: Awaited<ReturnType<typeof deriveAuthSecret>>) => Promise<R>): Promise<R> {
  if (!privateAvailable()) throw new PayError("PRIVATE_UNAVAILABLE");
  return withSigner(account, async (signer) => {
    const wallet = walletFor(signer);
    const authSecret = await deriveAuthSecret(wallet, T.idRegistry);
    const c = new Client(client, wallet, {
      idRegistryAddress: T.idRegistry,
      contractAddress: T.merces,
      erc20Address: T.token,
      authSecret,
      ...taceoUrls(),
    });
    try {
      return await fn(c, wallet, authSecret);
    } catch (e) {
      throw mapError(e);
    }
  });
}

const walletFor = (signer: Parameters<Parameters<typeof withSigner>[1]>[0]) =>
  createWalletClient({ account: signer, chain, transport: http(config.rpcUrl) });

function mapError(e: unknown): Error {
  if (e instanceof PayError) return e;
  if (e instanceof NotCompliantError) return new PayError("PRIVATE_NOT_COMPLIANT");
  if (e instanceof UserGroupAmountLimitError) return new PayError("PRIVATE_LIMIT_1_USDC");
  if (e instanceof UserGroupTransactionLimitError) return new PayError("PRIVATE_EPOCH_LIMIT");
  if (e instanceof InsufficientBalanceError) return new PayError("INSUFFICIENT_BALANCE");
  if (e instanceof AlreadyRegisteredInDifferentGroupError) return new PayError("PRIVATE_OTHER_GROUP");
  if (e instanceof ActionTimeoutError) return new PayError("PRIVATE_STILL_PROCESSING");
  const msg = String((e as Error)?.message ?? e);
  if (/insufficient funds|gas/i.test(msg)) return new PayError("PRIVATE_NEEDS_MON");
  return e instanceof Error ? e : new Error(msg);
}

/** Join the private network (compliance check + one registry transaction). Idempotent. */
export async function joinPrivate(account: Account): Promise<void> {
  await withMerces(account, async (_c, wallet, authSecret) => {
    if (await isRegistered({ publicClient: client, idRegistryAddress: T.idRegistry, address: account.address })) return;
    const complianceData = await fetchComplianceData(taceoUrls().complianceUrl, account.address);
    await register({ publicClient: client, walletClient: wallet, idRegistryAddress: T.idRegistry, authSecret, groupId: T.groupId, maxFee: 0n, complianceData });
  });
}

export const privateBalance = (account: Account) => withMerces(account, (c) => c.privateBalance());

function check(amount: bigint) {
  const p = privateAmountProblem(amount);
  if (p) throw new PayError(p);
}

/** Move public USDC into the private balance (visible: amount and account). */
export async function depositPrivate(account: Account, amount: bigint): Promise<Hash> {
  check(amount);
  return withMerces(account, (c) => c.deposit({ amount }));
}

/** Private Send: sender, receiver and amount are hidden. The receiver must already have joined. */
export async function sendPrivate(account: Account, receiver: Address, amount: bigint): Promise<Hash> {
  check(amount);
  if (!(await isRegistered({ publicClient: client, idRegistryAddress: T.idRegistry, address: receiver }))) throw new PayError("PRIVATE_RECEIVER_NOT_JOINED");
  return withMerces(account, (c) => c.transfer({ receiver, amount }));
}

/** Move private USDC back to the public balance (visible: amount and destination). */
export async function withdrawPrivate(account: Account, amount: bigint): Promise<Hash> {
  check(amount);
  return withMerces(account, (c) => c.withdraw({ amount }));
}
