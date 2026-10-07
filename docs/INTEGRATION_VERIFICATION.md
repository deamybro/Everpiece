# Integration verification log

Every external fact the code relies on, with its source, how it was checked and when. (Owner mandate §1.2. Older
facts live in `docs/VERIFIED.md`; new entries are mirrored there.)

## Monad testnet
| Fact | Value | Source / check | Date |
|---|---|---|---|
| Chain ID | 10143 | `eth_chainId` on https://testnet-rpc.monad.xyz; Monad docs (VERIFIED §4.9) | 2026-10-02 |
| `eth_getLogs` range limit | 100 blocks | live RPC error (VERIFIED §4.9) | 2026-10-02 |
| Finality | head − 2 | VERIFIED §1.14 | 2026-09-29 |

## Agora AUSD (Monad testnet)
| Fact | Value | Source / check | Date |
|---|---|---|---|
| AUSD token | `0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC` | https://docs.agora.finance/developer/contract-deployments (Monad Testnet); `eth_getCode` 5,937 B | 2026-10-03 |
| AUSD name / symbol / decimals | "AUSD" / "AUSD" / **6** | `cast call` name(), symbol(), decimals() | 2026-10-03 |
| AUSD EIP-712 domain | name "Agora Dollar", version "1", chainId 10143, verifyingContract = token | `eip712Domain()` | 2026-10-03 |
| ERC-3009 receive | `RECEIVE_WITH_AUTHORIZATION_TYPEHASH` = `0xd099cc98…13de8`; `isReceiveWithAuthorizationUpgraded()` = **false** | `cast call` | 2026-10-03 |
| Proxy implementation | `0xc1e3C7D486d6A92fBE920232E439EeC2cEb112dA` (EIP-1967 slot) | `cast storage` | 2026-10-03 |
| AUSD faucet | `0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C`, `requestFunds(address)`, 10,000 AUSD per request | Agora deployments page + "Getting Testnet Tokens"; `token()` returns the AUSD address | 2026-10-03 |

## Agora Instant Settlement (Monad testnet)
| Fact | Value | Source / check | Date |
|---|---|---|---|
| Factory | `0x8468587Af422ad440F58a57E955eCA6A970b5375` | https://docs.agora.finance/instant-settlement/protocol-deployments ; code 2,345 B | 2026-10-03 |
| CTK / AUSD pair | `0x1Aa8958Aa34cEC8096EF4381cb335effe977b0ae`, name "CTK/AUSD" | same page; `name()` | 2026-10-03 |
| token0 / token1 | CTK `0x7BEb5D9DB0d85cBEa543C04f0dE8c23c2176cd9D` (18 dp) / AUSD (6 dp) | `token0()`, `token1()`, `decimals()` | 2026-10-03 |
| Reserves at check | 998,009.99 CTK / 1,001,990.01 AUSD | `reserve0()`, `reserve1()` | 2026-10-03 |
| Price / fees / paused | `getPrice()` = 1e30 (PRICE_PRECISION 1e18); purchase fees 0 / 0; `isPaused()` false | `cast call` | 2026-10-03 |
| Fixed-output swap | `getAmountsIn(uint256 amountOut, address[] path) → uint256[]` then `swapTokensForExactTokens(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline)`; pulls input from the caller (`safeTransferFrom`); reverts `ExcessiveInputAmount()` | pair-contract and swapping-fixed-output docs | 2026-10-03 |
| Permission | callers need `APPROVED_SWAPPER`; check with `hasRole(string role, address)` (role is a **string**) | pair-contract docs | 2026-10-03 |
| Testnet self-whitelisting | Whitelister `0x7c10F56d6f04a51376393a1C3670e966863F6BD5` holds WHITELISTER_ROLE on all testnet pairs; **anyone** may call `setApprovedSwapper(address swapper)`; testnet only (mainnet = Agora KYC) | "Executing a Swap → Self-whitelisting"; code 1,200 B | 2026-10-03 |
| CTK token | "ConstantToken"/CTK, 18 dp, EIP-712 "ConstantToken" v1 on 10143, `nonces(address)` present (ERC-2612 shape). **Permit acceptance still to be proven** with a simulated `permit` before relying on it | `cast call` | 2026-10-03 |
| CTK faucet | the documented one (`0xf8A143b3…B1D`) has **no code on Monad testnet** (Sepolia only). Test CTK must come from the pair (AUSD → CTK swap) | `eth_getCode` | 2026-10-03 |

## 0x
| Fact | Value | Source | Date |
|---|---|---|---|
| Swap / Gasless support | Monad **143** ✅; no Monad testnet entry | https://docs.0x.org/docs/introduction/supported-chains.md | 2026-10-03 |
| Exact output | Swap API `buyAmount` (exact out) returns `maxSellAmount`; `recipient` sends to a third party | https://docs.0x.org/evm/0x-swap-api/additional-topics/exact-buy.md | 2026-10-03 |
| Consequence | `ZeroXRoutingProvider` returns UNSUPPORTED_NETWORK on 10143; no live 0x calls on testnet | — | 2026-10-03 |

## Mera
| Fact | Value | Source | Date |
|---|---|---|---|
| Package | `@category-labs/mera` 0.2.0 (preview) | installed package.json | 2026-10-03 |
| Platforms | web browsers; React Native on iOS 18+ and Android 9+ (peer `react-native-passkey` 3.6.1) | package README; `dist/react-native-webauthn-client.js` | 2026-10-03 |
| Recovery | same passkey → same PRF output → same account (EVERPIECE_ACCOUNT_V1; VERIFIED §3.4) | existing 3-implementation vectors | 2026-09-29 |

## Kuru × Anchored aStocks: live mainnet execution check (2026-10-06 23:45 → 2026-10-07 00:15 UTC)

**Verdict: `KURU_ASTOCK_EXECUTION = NOT_AVAILABLE`.** No `KuruInvestmentProvider` was created and Invest is not implemented.
- **aAAPL and aMSFT:**
  - no Kuru market;
  - no Kuru Flow route in any direction;
  - no liquidity anywhere Flow looks.
- **aNVDA:**
  - no Kuru market either;
  - Kuru Flow does build a route, but entirely through **non-Kuru** liquidity (USDC→WMON pools, then a tiny Uniswap v4 MON/aNVDA pool).
  - It is **rejected** as clearly broken/shallow: +25.8% over the reference price at $5 and +53.1% at $25, about 10% between buying and selling at the smallest size, and a $10 build that reverted in simulation.
- No transaction was submitted and no mainnet funds were spent. Swaps were only simulated on a local anvil fork.

Raw evidence: `evidence/kuru-astocks-2026-10-07/` (described at the end of this section).

### Tokens (chain 143, `rpc.monad.xyz`, block 111,172,226)
| Token | Address | name / symbol / decimals | totalSupply | Code |
|---|---|---|---|---|
| aNVDA | `0x701193374879131f923532987c7ef363a91a80eb` | "NVIDIA aStock" / aNVDA / 18 | 57.8169 | 291 B (proxy) |
| aAAPL | `0x17683e492d0c8910f7c0157d04af31cb7a23ad71` | "Apple aStock" / aAAPL / 18 | 44.6526 | 291 B (proxy) |
| aMSFT | `0x73e9eb2c7a4b4e8c68232b31ea0f1246963d0375` | "Microsoft aStock" / aMSFT / 18 | 26.9330 | 291 B (proxy) |
| USDC | `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` | USDC / USDC / 6 | — | 1,798 B |

`TODO(VERIFY): 1 aStock = 1 underlying share — Anchored's own docs.` Only third-party pages (DefiLlama RWA, press) state 1:1 Alpaca-held backing. The verdict doesn't depend on it: the buy/sell gap and how fast the price worsens with size are measured directly.

### Kuru contracts used (https://docs.kuru.io/contracts/Contract-addresses)
| Contract | Address | Check |
|---|---|---|
| Router (market factory) | `0xd651346d7c789536ebf06dc72aE3C8502cd695CC` | code 141 B (proxy); `verifiedMarket(address) → MarketParams` (11 words: pricePrecision, sizePrecision, base, baseDecimals, quote, quoteDecimals, tickSize, minSize, maxSize, takerFeeBps, makerFeeBps) |
| KuruFlowEntrypoint | `0xb3e6778480b2E488385E8205eA05E20060B813cb` | the `transaction.to` of every Flow quote |
| MarginAccount | `0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5` | holds **0** aNVDA / aAAPL / aMSFT (where Kuru order-book balances live) |

### 1. Market discovery: no Kuru market for any aStock
- **Live API** `GET https://exchange.kuru.io/api/v3/exchangeInfo` (2026-10-06 23:48:12 UTC; `exchangeInfo.json`):
  - 7 symbols: WETH_USDC, XAUT_USDC, WBTC_AUSD, AUSD_USDC, MON_USDC, MON_AUSD, cbBTC_USDC;
  - **0** involve an aStock.
- **On-chain, the source of truth:** every `MarketRegistered` event the Router has ever emitted.
  - Query: `eth_getLogs` from block 0 to 111,173,255 on `rpc1.monad.xyz`; topic `0x8fd54793…842eab`.
  - Result: **597 markets**, 586 distinct tokens, **0** with aNVDA, aAAPL or aMSFT as base or quote (`router-markets-decoded.json`).
  - The last registration was at block 101,476,410. After it, the Router emitted only `KuruRouterSwap` ×5,042, one `Upgraded`, `OBImplementationUpdated` and `VaultImplementationUpdated`. There is no new or unknown registration event, so no market was created in any form since.
  - **None of those 5,042 Router swaps has an aStock leg.**
- **`verifiedMarket` for every market the API returned:**
  - All 7 are verified: the struct is non-zero, and base/quote match the API.
  - Calibration on the documented MON-USDC market `0x065C…C394`: base = native, 18 dp; quote = USDC, 6 dp; tickSize 100; fees 0/0.
  - The three aStock addresses themselves → all-zero (not markets).
- **Direct `USDC/aStock`, `aStock/USDC`, `MON/aStock` and reverse markets:** none exist, so there is nothing to verify.

### 2. Kuru Flow quotes (`POST https://ws.kuru.io/api/quote`, `autoSlippage: true`, no referrer; `quotes.json`)
**Setup:**
- JWT from `/api/generate-token` (rate limit 1 rps, burst 1).
- `userAddress` = our deployer `0xc905…8eAe`, used only for quoting.
- **Positive control:** USDC→MON $10 → 352.016 MON (MON ≈ $0.02841).
- **Reference price:** NVDA closed at **$239.24** on 2026-10-06 (https://stockanalysis.com/stocks/nvda/history/; corroborating 10-05 close $238.90 on heygotrade). The quotes were taken after hours.

| Request (23:52–23:54 UTC) | Result | Expected out | Effective price | vs NVDA $239.24 |
|---|---|---|---|---|
| USDC→aNVDA $5 | route | 0.016626 aNVDA (minOut 0.016572) | $300.74 | **+25.7%** |
| USDC→aNVDA $10 | route | 0.031531 (minOut 0.031430) | $317.14 | **+32.6%** |
| USDC→aNVDA $25 | route | 0.068268 (minOut 0.068050) | $366.20 | **+53.1%** |
| AUSD→aNVDA $10 | route | 0.031583 | $316.62 | +32.3% |
| MON→aNVDA 500 MON (≈$14.2) | route | 0.043009 | $330.26 | +38.0% |
| aNVDA→USDC 0.01 | route | 2.718410 USDC | $271.84 | +13.6% |
| aNVDA→MON 0.01 | route | 95.7198 MON | $271.92 | +13.7% |
| USDC/AUSD/MON → aAAPL, aAAPL → USDC/MON (all sizes) | **no route** | "no candidate paths available between tokens" | — | — |
| USDC/AUSD/MON → aMSFT, aMSFT → USDC/MON (all sizes) | **no route** | same | — | — |

One USDC→aAAPL $10 request returned HTTP 502 (an intermittent Kuru gateway error, seen twice in this session). The $5 and $25 requests either side of it returned "no candidate paths".

### 3. Can the aNVDA transaction actually be built and executed? (local anvil fork, nothing broadcast; `sim.json`)
**Method:**
- A fresh quote for each size.
- The fork is reset to the live head (`rpc3.monad.xyz`) right after the quote.
- Test USDC moved to the quoting address from Kuru's MarginAccount by impersonation (fork only).
- Approve the entrypoint, then send the quoted calldata.

| Size | Result | Gas used | Received | Effective price |
|---|---|---|---|---|
| $5 | success | 976,642 | 0.016610 aNVDA (≥ minOut) | $301.02 (+25.8%) |
| $10 | **revert `ETHTransferFailed()` (0xb12d13eb)** at `eth_estimateGas`, fork block 111,176,616, on two separate fresh quotes | — | — | — |
| $25 | success | 978,282 | 0.068259 aNVDA | $366.25 (+53.1%) |

**Gas:** about 0.98M gas. Monad charges the gas limit (VERIFIED §1.14), so at the ×1.3 limit and the quoted 108 gwei standard price, that is about 0.137 MON ≈ $0.004. Gas is not the problem.

**Route actually executed (from logs and decoded calldata):**
1. USDC → WMON through `0x63e4…53f2` (token0 WMON / token1 USDC, fee 500) and a Liquidity Book pair `0x5afd…7620`. **No Kuru order-book market is touched.**
2. Unwrap to MON.
3. MON → aNVDA in **Uniswap v4** (PoolManager `0x188d586d…ea8e`, confirmed on https://developers.uniswap.org/docs/protocols/v4/deployments, "Monad: 143"):
   - pool id `0x4887…2448` (native MON / aNVDA, fee 2500, no hooks);
   - initialized at block 103,051,054.

**Depth of that pool** (StateView `0x7739…9d64`, block 111,177,682):
- liquidity 3.05e19;
- marginal price 9,938 MON/aNVDA ≈ **$282 (+18% vs reference)**;
- the PoolManager holds **0.505 aNVDA in total across every v4 pool (≈ $120–140)**, and **0** aAAPL / aMSFT.

**Other v4 pools** (from `Initialize` logs, `uniswap-v4-initialize-logs.json`):
- 14 other aNVDA pools against unrecognised tokens or custom hooks;
- one hooked aAAPL pool;
- no aMSFT pool;
- Kuru Flow uses none of them.

### 4. Why the aNVDA route is rejected
- **Price:**
  - every buy is 25–53% above the underlying;
  - the pool's own mid price is +18% off, i.e. not arbitraged against NVDA;
  - buying and selling 0.01 differ by about 10% ($301 vs $272).
- **Depth:** about 0.5 aNVDA in the whole venue; $25 moves the price 22% beyond the $5 price.
- **Reliability:** one of three sizes ($10) reverts during simulation.
- **Not Kuru:** Kuru's order books have no aStock market, and Flow is only passing through a third-party pool.

**Re-check trigger:** a `MarketRegistered` event on the Router with an aStock as base or quote, or a Flow quote within ~1% of the reference price at $25 that simulates cleanly. Re-run the evidence scripts before reconsidering. Anchored listing Kuru as a partner is not evidence of execution.

### Evidence files (`evidence/kuru-astocks-2026-10-07/`)
`exchangeInfo.json` (API response) · `registered.json` (raw Router `MarketRegistered` logs) · `router-markets-decoded.json` · `quotes.json` (every Flow request and response, with timestamps; the JWT is not stored) · `sim.json` (fork simulations $5/$25 with logs) · `uniswap-v4-initialize-logs.json` · `quotes.mjs` / `sim.mjs` (the scripts that produced them).
