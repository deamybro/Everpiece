# Everpiece Earn

> Your stablecoins earn yield. Your yield builds ownership. Principal is never touched, and that's enforced on-chain.

**Status (2026-10-08):**
- **Mainnet:** provider verified read-only, and the full flow is proven on a mainnet fork against the real Aave V3. EverpieceEarn is **not deployed on mainnet** (that needs owner GO).
- **Testnet:** live, with **SIMULATED yield** (Aave has no Monad testnet).

## 1. Provider (one, verified)

| | Mainnet (Monad 143) | Testnet (10143) |
|---|---|---|
| Vault | Aave V3 "Wrapped Aave Monad AUSD" (waMonAUSD) `0x9e1AcC5BFbf34e2E579763cE14042d957719fE76` | `TestYieldVault (SIMULATED)` `0xf1c1b2432bA3f882E6f306E6a2B87A28Fe39aDD9` |
| Asset | AUSD (no swap needed: AUSD is a core Aave Monad reserve) | real Agora testnet AUSD |
| Rate | **Live**: `Pool.getReserveData(AUSD).currentLiquidityRate` (ray APR → shown as APY). Never a constant: 3.09% APR at one read, and ≈1.3% realised over a later 30-day fork window | Simulated: the test stack adds test AUSD at a simulated 5% a year every 10 minutes, plus a test-only "Add simulated earnings" button ($1) |
| Router | EverpieceEarn: not deployed (owner GO) | EverpieceEarn `0x6516224894E0aB0A5a5A06703e985A97dFB6F75A` |
| Evidence | VERIFIED §4.17; `contracts/test/fork/EverpieceEarnFork.t.sol` | `scripts/deploy-testnet-earn.mjs` (verified at finality) |

**Why only one provider:**
- Morpho's Monad deployments weren't verified for AUSD.
- The mandate says one or two verified integrations, not five.

**Risks shown before any deposit:**
- The rate is variable.
- Withdrawals need free reserve liquidity (≈74% utilisation at check), so a full exit can have to wait.
- Aave's smart-contract and oracle risk applies.
- It is not insured and not a bank deposit.
- There is no "safe yield" claim anywhere.

## 2. EverpieceEarn (contracts/src/EverpieceEarn.sol)

**Gasless:** Everpiece accounts hold no MON. The owner only signs; the relayer submits.
- No owner, no admin, no upgrade path.
- The vault list is fixed at deploy, and each vault's `asset()` must be AUSD.

**Deposit:**
- The AUSD ERC-3009 `receiveWithAuthorization` nonce **is** the deposit id: the EIP-712 digest of {ref, owner, vault, assets, minShares, deadline}. A relayer can't change any term.
- Shares are minted to the owner. Fewer shares than `minShares` reverts.
- The contract keeps nothing.

**Withdraw:**
- The owner signs the Withdrawal {ref, owner, vault, assets, maxShares, deadline} plus an ERC-2612 permit on the shares.
- If the permit is front-run, the existing allowance is used.
- Assets go to the owner. The withdrawal settles once.

**On-chain principal: `principalOf[owner][vault]`.**
- It grows by each deposit.
- An owner withdrawal reduces it **principal first**, and never below 0.
- A **HARVEST** (a withdrawal whose signed `ref` starts with `"HRV1"`) **reverts with `PrincipalProtected`** if the position would be left worth less than its principal.
- This is the guard Earn → Invest relies on. It does not depend on any off-chain ledger, so a lagging indexer that reads principal as $0 can't make the deposit "harvestable" (tested on-chain and end to end).

**Tests:**
- Unit: 14 (incl. fuzz; harvest can't touch principal; principal-first withdrawals; EIP-712 parity with `packages/shared`).
- Mainnet fork against the real Aave wrapper: 2.

**Gas (cold state, real Aave):** deposit 689k, withdraw 610k. Relayer limits are 800k / 750k, tied to the fork test by `server/relayer/test/gasLimits.test.ts`.

## 3. Accounting (`packages/shared/src/earn.ts`)

| Field | Source |
|---|---|
| `currentRedeemableValue` | `vault.convertToAssets(vault.balanceOf(owner))`, on-chain |
| `netPrincipal` | `EverpieceEarn.principalOf(owner, vault)`, **on-chain, authoritative** |
| `harvestableYield` | max(0, redeemable − principal − 2 units of ERC-4626 rounding margin) |
| `principalDeposited` / `principalWithdrawn` / `yieldAlreadyHarvested` | indexed `EarnEvent`s (Envio), for history and display only |

**Accounting model:**
- `ERC4626_MONOTONIC`: the share price never decreases in normal operation (Aave normalised income; the test vault's donations).
- After any loss, harvestable is 0. Principal is never reported as yield.
- Any other model is refused (`UNSUPPORTED_ACCOUNTING_MODEL`).

**Owner decision (money semantics, recorded):**
- An owner's own withdrawal counts as **principal first**.
- Alternative: count it as earnings first, which would leave a larger principal to protect and fewer earnings to invest.
- Principal first is the default in both the contract and the TypeScript. TODO: owner confirmation.

## 4. App
- `/earn`:
  - provider, live rate, risks;
  - deposited (on-chain principal), worth now, earnings you can take, earnings taken;
  - Put in / Take out, plus "Take my earnings — deposit stays";
  - activity with explorer links;
  - on the test site, a SIMULATED banner and "Add simulated earnings (test only)".
- Home: an "Earn" card in the Grow group.
- E2E: `web/e2e/earn.spec.ts`.

## 5. Mainnet checklist (owner GO required)
1. Deploy EverpieceEarn with `[waMonAUSD]`.
2. Set `EARN_ADDRESS` on the relayer and `NEXT_PUBLIC_EARN_*` on the web.
3. One small real deposit and withdrawal, with the receipt, event and finality verified.
