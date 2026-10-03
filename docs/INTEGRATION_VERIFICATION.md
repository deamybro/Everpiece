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
