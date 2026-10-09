/**
 * TACEO Merces on Monad mainnet (docs.taceo.io "Deployments and status", re-checked 2026-10-09; VERIFIED §4.11):
 * confidential USDC balances and transfers, "Mainnet, limited users, volume caps". Group 4 (ANON): fee 0,
 * max 1 USDC per action, 35 actions per epoch, 100 members. Deposits/withdrawals need the compliance attestation;
 * the user's own wallet submits (no relayer documented), so it needs MON for gas.
 */
export const TACEO_MERCES_MONAD = {
  chainId: 143,
  idRegistry: "0xF55DFe8242ec117F44Acd932adb5C233b582A04a",
  merces: "0x9Dd5DE40592AdfcDD60F0f3fF3B014553998f7c1",
  token: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
  groupId: 4n,
  maxAmountPerTx: 1_000_000n,
  maxTxsPerEpoch: 35,
  maxMembers: 100,
  nodeUrls: [
    "https://query.node0.usdc.monad.merces.taceo.network",
    "https://query.node1.usdc.monad.merces.taceo.network",
    "https://query.node2.usdc.monad.merces.taceo.network",
  ],
  complianceUrl: "https://compliance.usdc.monad.merces.taceo.network/",
} as const;

/** What a private (Merces) transfer hides and what it doesn't — shown to users verbatim, never overstated. */
export const PRIVATE_SEND_DISCLOSURE = {
  hidden: ["who sent it", "who received it", "how much"],
  visible: [
    "that your account is registered for private payments",
    "the amount and account when you move USDC in (deposit)",
    "the amount and destination when you move USDC out (withdraw)",
  ],
} as const;

/** Client-side checks the network also enforces (null = OK). */
export function privateAmountProblem(amount: bigint): string | null {
  if (amount <= 0n) return "INVALID_AMOUNT";
  if (amount > TACEO_MERCES_MONAD.maxAmountPerTx) return "PRIVATE_LIMIT_1_USDC";
  return null;
}
