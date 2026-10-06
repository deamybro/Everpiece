# VERIFIED.md — External Facts Registry

This file answers: **what is true?** Every production external constant must map to an entry here.
Readiness lives in `INTEGRATION_LEDGER.md`.

Source priority (Master Prompt §0.2): deployed contract/verified source > official docs > installed official SDK types > official GitHub > team comms > blog > third party.
When docs and deployed behavior disagree, the disagreement is recorded and **deployed behavior wins**.

Legend for "Checked by": `Everpiece team` = engineering session 1 (2026-09-29).

---

## 1. Monad Mainnet

### 1.1 Chain ID
- **Fact:** Monad Mainnet chain ID
- **Value:** `143` (`0x8f`)
- **Official source:** https://docs.monad.xyz/developer-essentials/network-information ; https://docs.monad.xyz/ai/current-facts.md
- **Explorer / verified-source reference:** Live `eth_chainId` on `https://rpc.monad.xyz` returned `0x8f`.
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:** Testnet is `10143` (current-facts page). Also confirmed by AUSD `eip712Domain()` returning chainId 143.

### 1.2 Public RPC endpoints (development only)
- **Fact:** Official public RPC endpoints and rate limits
- **Value:**
  | Provider | HTTP | WS | Limit |
  |---|---|---|---|
  | QuickNode | `https://rpc.monad.xyz` | `wss://rpc.monad.xyz` | 25 rps |
  | Alchemy | `https://rpc1.monad.xyz` | `wss://rpc1.monad.xyz` | 15 rps |
  | Goldsky Edge | `https://rpc2.monad.xyz` | `wss://rpc2.monad.xyz` | 300 / 10 s |
  | Ankr | `https://rpc3.monad.xyz` | `wss://rpc3.monad.xyz` | 300 / 10 s |
  | MF | `https://rpc-mainnet.monadinfra.com` | `wss://rpc-mainnet.monadinfra.com` | 20 rps |
- **Official source:** https://docs.monad.xyz/developer-essentials/network-information
- **Explorer / verified-source reference:** `rpc.monad.xyz` used successfully for all live reads in this session.
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:** Public RPCs are rate-limited. The production relayer needs a dedicated provider (TODO(VERIFY): provider choice + method-specific limits — https://docs.monad.xyz/reference/rpc-limits).

### 1.3 Explorers
- **Fact:** Official block explorers
- **Value:** MonadVision `https://monadvision.com`; Monadscan `https://monadscan.com`
- **Official source:** network-information page
- **Explorer / verified-source reference:** n/a
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:** Sourcify (`https://sourcify.dev/server/v2/contract/143/<addr>`) holds verified sources for AUSD (see §2).

### 1.4 Network version
- **Fact:** Current mainnet client version / revision
- **Value:** **Disagreement between official pages.** `current-facts.md`: `v0.16.1` / `MONAD_TEN`. `network-information`: `v0.15.2` / `MONAD_NINE`.
- **Official source:** both pages above; canonical JSON at https://docs.monad.xyz/networks.json
- **Explorer / verified-source reference:** not checked
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:** TODO(VERIFY): read `/networks.json` before deployment. Not money-critical.

### 1.5 Gas is charged on gas LIMIT, not gas used
- **Fact:** Fee = `gas_limit × price_per_gas`; total deducted = `value + gas_bid × gas_limit`
- **Value:** Charged on full gas limit
- **Official source:** https://docs.monad.xyz/developer-essentials/gas-pricing ; https://docs.monad.xyz/developer-essentials/differences
- **Explorer / verified-source reference:** n/a
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:** Relayer must set tight, explicit gas limits per action (docs recommend a hardcoded gas limit when usage is static, skipping `eth_estimateGas`). A padded limit is paid in full.

### 1.6 Base fee / EIP-1559
- **Fact:** Minimum base fee and fee formula
- **Value:** Min base fee `100 MON-gwei` (100e-9 MON). `price_per_gas = min(base + priority, max)`. Live `baseFeePerGas` = `100000000000` wei (100 gwei) at block 108,885,700; `eth_gasPrice` returned 102 gwei.
- **Official source:** gas-pricing page
- **Explorer / verified-source reference:** live `eth_getBlockByNumber latest`
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:** Controller "increases more slowly and decreases more quickly" than Ethereum's.

### 1.7 Block / transaction gas limits
- **Fact:** Block gas limit, per-tx gas limit
- **Value:** Block gas limit **150,000,000** (live block header confirms). Per-transaction gas limit **30,000,000**.
- **Official source:** gas-pricing page; current-facts page
- **Explorer / verified-source reference:** live block 108,885,700 `gasLimit = 150000000`
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:** **Doc inconsistency:** gas-pricing controller parameters state `target = 160M (80% full)` which implies a 200M limit; live chain and the same page's summary say 150M. Deployed behavior (150M) wins. Irrelevant for Everpiece tx sizes.

### 1.8 Block time / finality
- **Fact:** Block time and finality
- **Value:** ~300 ms blocks (mean ~302 ms Sept 2026). Speculative finality 1 slot (~300 ms); full finality 2 slots (~600 ms).
- **Official source:** https://docs.monad.xyz/ai/current-facts.md
- **Explorer / verified-source reference:** n/a
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:** UI may show "Payment protected" only after the relayer observes a receipt; the relayer should treat full finality (2 slots) as final.

### 1.9 Reserve Balance
- **Fact:** Reserve-balance rules
- **Value:** `user_reserve_balance = 10 MON`. Execution delay k (a.k.a. D) = 3 blocks. Consensus budgets **gas spend of all in-flight txs per EOA** to `min(10 MON, lagged balance)`. At execution, value spend that drops an account below the reserve reverts (with exceptions). EIP-7702-delegated EOAs cannot drop below 10 MON.
- **Official source:** https://docs.monad.xyz/developer-essentials/reserve-balance ; differences page
- **Explorer / verified-source reference:** n/a
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes (relayer impact):** A single relayer EOA can only have ≤10 MON of gas spend in flight across the last k blocks. At ~100 gwei × ~200k gas limit ≈ 0.02 MON/tx that is ~500 in-flight txs — plenty for the hackathon, but: (1) keep relayer balance > 10 MON to avoid the balance being the binding budget, (2) shard across multiple relayer EOAs if throughput grows, (3) relayer never sends MON value. Everpiece user accounts never hold MON, so reserve rules do not affect them.

### 1.10 Asynchronous execution / mempool
- **Fact:** Consensus precedes execution; no global mempool
- **Value:** Consensus on block N uses state from N−3. Transactions are forwarded to the next few leaders ("Local Mempool"); there is no global public mempool.
- **Official source:** https://docs.monad.xyz/monad-arch/consensus/asynchronous-execution ; differences page
- **Explorer / verified-source reference:** n/a
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes (relayer impact):** A tx can be included and still revert at execution (still pays full gas limit). Relayer must: manage nonces locally, pre-simulate with `eth_call`, and treat inclusion ≠ success until receipt status is read. Front-running is harder without a global mempool but **must not be relied on for safety**.

### 1.11 EVM / Solidity compatibility
- **Fact:** Opcode/precompile support and toolchain
- **Value:** All opcodes as of the **Fusaka** fork (incl. CLZ via MIP-5 Osaka EIPs); all Ethereum precompiles `0x01`–`0x11`; P-256 verify precompile at `0x0100` (EIP-7951); staking precompile `0x1000`. Max contract code 128 KB, initcode 256 KB. Memory expansion is linear, 8 MB cap per tx. Storage warmed per 128-slot page. No blob (type 3) txs. Docs require **Foundry ≥ v1.8.0** with `network = "monad"` in `foundry.toml` (or `--network monad`) so local tests follow Monad execution rules.
- **Official source:** https://docs.monad.xyz/developer-essentials/summary ; differences page ; https://docs.monad.xyz/guides/deploy-smart-contract/foundry
- **Explorer / verified-source reference:** AUSD implementation on mainnet compiled with solc 0.8.28, `evmVersion: cancun` (Sourcify)
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:** Proposed escrow pragma: `0.8.28` with `evm_version = "cancun"` (conservative; matches what AUSD itself ships on Monad). Toolchain now satisfied — see §1.12.

### 1.12 Local toolchain (installed)
- **Fact:** Installed Foundry version and Monad configuration
- **Value:** `forge 1.8.3 (cae51ad458, 2026-09-15)`; cast/anvil/chisel same. Installed with the official `foundryup`; binaries verified against the release attestation (`forge verified ✓` …). Required config in `foundry.toml`: `network = "monad"` (persistent equivalent of `--network monad`, which "makes Forge use Monad's execution rules for local compilation, testing, scripts, and transaction simulation").
- **Official source:** https://docs.monad.xyz/guides/deploy-smart-contract/foundry ("v1.8 or later"); https://docs.monad.xyz/developer-essentials/summary
- **Explorer / verified-source reference:** `forge --version`; `forge test --help` lists `-n, --network <NETWORK>`
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:** Replaces Foundry 1.6.0 used for the first probe run. All evidence was re-run on 1.8.3 with `network = "monad"` (§2.12). Monad-mode gas figures are higher than plain-EVM figures (cold-access repricing). Monad also publishes a `monad-developers/foundry-monad` template (not used; plain `forge init` + `network = "monad"`).

---

### 1.14 JSON-RPC block tags, finality and receipts (relayer "inclusion ≠ success")
- **Fact:** How Monad RPC exposes block commitment, and what that means for receipts
- **Value:**
  - Tags: `"latest"` = **Proposed** (speculatively executed, no vote yet); `"safe"` = **Voted**; `"finalized"` = **Finalized** ("irreversible without a hard fork. Use for value settlement: bridges, deposits, payment crediting"). `"pending"` behaves as `"latest"`.
  - A 4th state, **Verified** (execution outputs agreed via the delayed merkle root), is `latest_finalized − execution_delay(3)`.
  - `eth_getTransactionReceipt` / `eth_getTransactionByHash` / `eth_getLogs` can return data from non-finalized blocks, and "the returned blockNumber, log indices, or even the result itself (null) can change".
  - Docs tip: compare the receipt's `blockNumber` against the client-tracked `"finalized"` height before acting.
  - `eth_getTransactionByHash` never returns mempool (pending) txs.
  - `eth_sendRawTransaction` may accept txs with a nonce gap or insufficient balance (deferred validation).
  - `eth_sendRawTransactionSync(hex_tx, timeout_ms)` exists and returns a receipt.
  - `eth_maxPriorityFeePerGas` currently returns a hard-coded 2 gwei.
  - Live batched read: `latest` N, `safe` N−1, `finalized` N−2 (≈ 600 ms lag).
- **Official source:** https://docs.monad.xyz/monad-arch/consensus/block-states ; https://docs.monad.xyz/reference/json-rpc/overview ; https://docs.monad.xyz/reference/json-rpc/api#eth_sendrawtransactionsync
- **Explorer / verified-source reference:** Batched `eth_getBlockByNumber` for latest/safe/finalized on `rpc.monad.xyz` → 109037945 / 109037944 / 109037943
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:** Relayer/UI rule (ESCROW_SPEC §17): financial success requires a receipt with `status == 1` **and** `receipt.blockNumber <= finalized height`, plus the expected escrow event and `getPayment` state read at `"finalized"`. A receipt from `eth_sendRawTransactionSync` alone is not success; it may be from a Proposed block. Relayers must not trust `eth_sendRawTransaction` acceptance as a nonce/balance check.

### 1.13 Pinned contract / tooling dependencies
- **Fact:** Dependency versions used by `contracts/` and `packages/shared`
- **Value:**
  - OpenZeppelin Contracts **v5.7.0** (latest release, published 2026-07-29), git submodule at commit `cab19933c33c2ad1d4c7a84864a3601dddfd16f3`
  - forge-std **v1.16.2** (latest release, 2026-06-30)
  - solc 0.8.28
  - Slither **0.11.6** (PyPI, scratch virtualenv)
  - `packages/shared`: viem **2.56.9**, @scure/bip39 **2.4.0**, @scure/bip32 **2.4.0**, TypeScript **7.0.2**, Node ≥ 24 (local 26.4.0)
- **Official source:** https://github.com/OpenZeppelin/openzeppelin-contracts/releases ; https://github.com/foundry-rs/forge-std/releases ; npm registry ; PyPI
- **Explorer / verified-source reference:** `git -C contracts/lib/openzeppelin-contracts describe --tags` → v5.7.0; `package.json` version 5.7.0
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:** APIs used were read from the pinned source, not from memory: `ECDSA.tryRecoverCalldata` (65-byte only, low-s enforced), `EIP712`, `Pausable`, `ReentrancyGuard`, `Ownable2Step`, `SafeERC20`.

## 2. AUSD (Agora Dollar) on Monad Mainnet

All §2 facts were verified against **Sourcify-verified deployed source** (full match, runtime + creation) and **live reads**, and behaviorally on a **mainnet fork** (see §2.12).

### 2.1 Token address
- **Fact:** AUSD proxy (the token address users hold)
- **Value:** `0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a`
- **Official source:** Agora docs (lead, given in Master Prompt)
- **Explorer / verified-source reference:** Sourcify chain 143 — contract `AgoraDollarErc1967Proxy` (`agora-dollar-evm/src/contracts/proxy/AgoraDollarErc1967Proxy.sol`), solc 0.8.21, match = `match`, verified 2026-09-01. Runtime code size 5,937 bytes.
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:** Live `name()` = `"AUSD"`, `symbol()` = `"AUSD"`, `totalSupply()` = 150,421,873.755948 AUSD at check time.

### 2.2 Decimals
- **Fact:** AUSD decimals
- **Value:** `6`
- **Official source:** Agora docs (lead)
- **Explorer / verified-source reference:** live `decimals()` → 6; fork test `test_decimals`
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:** $200.00 = `200000000` base units.

### 2.3 Proxy / implementation / upgradeability
- **Fact:** Proxy structure
- **Value:** Custom ERC-1967 proxy. Implementation slot `0x3608…2bbc` holds `0xc1e3C7D486d6A92fBE920232E439EeC2cEb112dA` (`AgoraDollar`, version `2.1.0`, solc 0.8.28, Sourcify full match). **The same slot's upper bits are feature flags** (pause bits, "function upgraded" bits). Proxy admin = `0xB8fCC66d613e5f54ee6A425DDbf4a2fDBE4Dedee` (`AgoraProxyAdmin`, Ownable2Step), owner `0x68898B77EbF7b55dCA8A2e62d6Fd74959a2930e2`. Admin can only call `upgradeToAndCall`.
- **Official source:** verified source
- **Explorer / verified-source reference:** Sourcify; live `cast storage` of slot `0x360894a1…2bbc` = `0x…c1e3c7d4…12da` (all flag bits 0)
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:** **The proxy itself implements `transfer`, `transferFrom`, `transferWithAuthorization` (both overloads) and `receiveWithAuthorization` (both overloads) inline for gas.** Each has an `is…Upgraded` flag; if set, the call is delegated to the implementation instead. Everything else (permit, cancelAuthorization, views, admin) is delegated. **AUSD is upgradeable by Agora**; the escrow must not assume token semantics are frozen (→ balance-delta checks, THREAT_MODEL A-ISSUER-*).

### 2.4 EIP-712 domain
- **Fact:** AUSD EIP-712 domain
- **Value:** `name = "Agora Dollar"` (**≠ `name()` which returns "AUSD"**), `version = "1"`, `chainId = 143`, `verifyingContract = 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a`, no salt. `eip712Domain()` fields byte `0x0f`. `DOMAIN_SEPARATOR()` = `0x995063441ebf2219c94dce05014a545da4390d2362f99b3d7ad456046678cafe`.
- **Official source:** verified source (`Eip712.sol`, constructor params)
- **Explorer / verified-source reference:** live `eip712Domain()`, `DOMAIN_SEPARATOR()`, `domainSeparatorV4()`; recomputed locally — exact match.
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:** **Frontends must hardcode domain name "Agora Dollar", not `name()`.** A client that builds the domain from `name()` will produce invalid signatures. Domain falls back to recomputation if `block.chainid` changes (fork-safe).

### 2.5 ERC-3009 `receiveWithAuthorization`
- **Fact:** Exact interface and semantics
- **Value:**
  - `receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)` — selector `0xef55bec6`
  - `receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)` — selector `0x88b7ab63`
  - Typehash `keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")` = `0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8`
  - **Checks, in order:** transfer not paused → signature verification not paused → `to == msg.sender` else `InvalidPayee(caller,payee)` → `block.timestamp > validAfter` else `InvalidAuthorization()` → `block.timestamp < validBefore` else `ExpiredAuthorization()` → nonce unused else `UsedOrCanceledAuthorization()` → signature valid else `InvalidSignature()` → mark used (emit `AuthorizationUsed`) → `_transfer` (reverts `AccountIsFrozen` if `from` or `to` frozen; `ERC20InsufficientBalance`).
  - `bytes` overload packs `r‖s‖v`.
- **Official source:** verified source (`Eip3009.sol`, `AgoraDollarErc1967Proxy.sol`)
- **Explorer / verified-source reference:** fork probe (§2.12)
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:** Validity window is **strict on both ends**: `validAfter < now < validBefore`. Using `validAfter = 0` is always satisfied. Payee enforcement means **only the escrow contract can consume an authorization whose `to` is the escrow.**

### 2.6 ERC-3009 `transferWithAuthorization`
- **Fact:** Exact interface
- **Value:** `(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)` selector `0xe3ee160e`; `bytes` overload selector `0xcf092995`. Typehash `0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267`. Same checks as receive **except no payee check** (anyone may submit) and an optional msg.sender-frozen check (flag currently off).
- **Official source / reference:** verified source; fork test shows a Receive signature is **not** valid as a Transfer signature (`InvalidSignature`).
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:** Everpiece **must not** use `transferWithAuthorization` for escrow funding (front-runnable; not payee-bound). It is suitable for post-claim recipient-initiated transfers (cash-out) where the destination is fixed in the signature.

### 2.7 Authorization state / cancellation
- **Fact:** Nonce model and cancellation
- **Value:** `authorizationState(address authorizer, bytes32 nonce) → bool`. Nonces are arbitrary `bytes32`, unordered, per-authorizer. `cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)` and `(address,bytes32,bytes)`; typehash `CancelAuthorization(address authorizer,bytes32 nonce)` = `0x158b0a9edf7a828aad02f63cd515c68ef2f50ba807396f6d12842833a1597429`; anyone may submit a signed cancel; emits `AuthorizationCanceled`.
- **Reference:** verified source; fork test `test_cancelAuthorization_blocks_use`
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team

### 2.8 ERC-2612 `permit`
- **Fact:** Exact permit interface
- **Value:** `permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)` and `permit(address,address,uint256,uint256,bytes)`. Typehash standard (`0x6e71edae…26c9`). `nonces(address)` sequential. Reverts if `block.timestamp > deadline` (**deadline itself is valid**). Blocked when signature verification paused.
- **Reference:** verified source (`Erc2612.sol`); fork test `test_permit_fallback_works`
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:** Available as fallback; not proposed for V1 (see ESCROW_SPEC §6.3).

### 2.9 Signature verification library
- **Fact:** How AUSD validates signatures
- **Value:** Solady `SignatureCheckerLib.isValidSignatureNow`: tries `ecrecover` for 64-byte (EIP-2098 compact) and 65-byte sigs; if that fails and `signer` has code, calls ERC-1271 `isValidSignature`.
- **Reference:** verified source; fork tests `test_compact_64byte_signature_accepted`, `test_erc1271_contract_from_supported`, `test_high_s_malleated_signature_accepted`
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:** **High-s (malleated) signatures are accepted.** Safety comes from the nonce, not signature uniqueness. Everpiece must never key anything on signature bytes.

### 2.10 Pause controls (issuer)
- **Fact:** Pause bits and live state
- **Value:** Flags: `isTransferPaused`, `isSignatureVerificationPaused`, `isMintPaused`, `isBurnFromPaused`, `isFreezingPaused`, `isBridgingPaused`, `isMsgSenderFrozenCheckEnabled`, and four `is…Upgraded` flags. **All `false` at check time.** Transfer pause blocks `transfer`, `transferFrom`, both ERC-3009 functions. Signature pause blocks ERC-3009 + permit but **not** plain `transfer`. Pauser role: `0x0b8Dd710f0260F16C0fA4F6a92D72d065E532A25`.
- **Reference:** live reads; fork tests `test_issuer_transfer_pause_…`, `test_issuer_signature_pause_…`
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:** A signature pause stops new payments but claims/refunds (plain `transfer` from escrow) still work.

### 2.11 Freeze and burn controls (issuer)
- **Fact:** Freeze and forced burn
- **Value:** `batchFreeze(address[])` / `batchUnfreeze` by FREEZER_ROLE (`0xcF7D2a525057555d7b4816941185b7ae10E94681`); `isAccountFrozen(address)`. Frozen `from` or `to` makes `_transfer` revert `AccountIsFrozen`. **`burn(address from, uint256 amount)` by BURNER_ROLE (`0x4375170c5Cfb5fa6a72Ce117194394a0E357dC1D`) burns from ANY account without allowance**; `batchBurnFrom` likewise. Bridge burner (`0x9CaB7Ede13dc56652E44D2404E969C212f22689b`) may burn only from non-frozen accounts. Minter `0x65e28662b0DCD6D89d4652A61FB0896d4F58D7fF`; rate-limit manager `0x72744c530b1b993bCbE779411BCaB4E02091d6dC`; access-control manager `0x68898B77EbF7b55dCA8A2e62d6Fd74959a2930e2`.
- **Reference:** verified source (`Erc20Privileged.sol`); live role reads; fork tests `test_issuer_freeze_on_escrow_blocks_outflows`, `test_issuer_freeze_on_recipient_blocks_claim_transfer`, `test_issuer_burner_can_burn_escrow_balance_without_allowance`
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:** **Issuer can freeze the escrow (all pending payments stuck) or burn escrow balance (solvency invariant broken by an external party).** Neither can be prevented by Everpiece; both are disclosed in THREAT_MODEL and the solvency invariant is stated "modulo issuer action".

### 2.12 Fork-probe evidence
- **Fact:** End-to-end behavior against live mainnet state
- **Value:** **21/21 pass on Foundry 1.8.3 with `network = "monad"`**, forked from `https://rpc.monad.xyz` at block ≈108,896,566 (2026-09-29). There are 16 AUSD behavior probes: a contract payee pulling funds via `receiveWithAuthorization`; replay blocked; third-party caller rejected (`InvalidPayee`); tampered amount rejected; strict validity boundaries; cancel; compact and high-s sigs; ERC-1271 `from`; permit; issuer freeze/burn/pause effects. There are 5 ESCROW_SPEC v0.2 vector checks, including **live AUSD accepting vector V_U3 (nonce = paymentId)** and the `isReceiveWithAuthorizationUpgraded` flag being observable.
- **Reference:** `evidence/milestone1/ausd-fork-probe/` (sources, `foundry.toml`, full test output). Later to be ported to `contracts/test/fork/`.
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:** The first run (Foundry 1.6.0, plain EVM) also passed; it is superseded by this run.

---

## 3. Mera (passkey accounts)

### 3.1 Package
- **Fact:** Official Mera package
- **Value:** `@category-labs/mera` **0.2.0** (latest dist-tag; npm modified 2026-08-12). Author Category Labs; repo `https://github.com/category-labs/mera`; docs `https://mera.category.xyz`. Exports: `.`, `./viem`, `./react-native-webauthn-client`. Deps: `@noble/curves 2.2.0`, `@noble/hashes 2.2.0`, `@scure/base 2.2.0`. Optional peers: `viem ^2.28.0`, `react-native-passkey 3.6.1`. `engines.node >= 24`.
- **Official source:** https://monad.xyz/blog/introducing-mera ; npm registry; package README
- **Explorer / verified-source reference:** Tarball `@category-labs/mera@0.2.0` unpacked and `.d.ts` read in this session.
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:** **Status: preview — "The API may change before 1.0."** Pin exact version. `github.com/nishuzumi/mera` is a **fork**, not official — do not use.

### 3.2 Web API (0.2.0 types)
- **Fact:** Public functions
- **Value:** `createPasskeyWithPrfOutput({ rp:{id,name}, user:{name,displayName}, timeout?, prfSalt?, webAuthnClient? }) → { credentialId, transports?, prfSalt, prfOutput }`; `getPasskeyPrfOutput({ rpId, credential?, prfSalt?, timeout?, webAuthnClient? }) → { credentialId, prfOutput }`; `createSecp256k1SigningSession({ privateKey }) → { publicKey, signDigest(d32) → {compact, recovery}, end(), [Symbol.dispose] }`; `getEvmAddress(publicKey)`; `toViemAccount(session, { nonceManager? })` (from `@category-labs/mera/viem`) implementing `signTransaction`, `signMessage`, **`signTypedData` (EIP-712)**, `signAuthorization` (EIP-7702), `sign`; secret-vault functions; `MeraError` codes `PASSKEY_OPERATION_FAILED | CRYPTO_UNAVAILABLE | PRF_UNAVAILABLE | SESSION_ENDED | DECRYPT_FAILED | INPUT_INVALID | VAULT_FORMAT_INVALID`.
- **Reference:** package `dist/*.d.ts`
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team

### 3.3 PRF behavior
- **Fact:** PRF semantics
- **Value:** 32-byte output, deterministic in (credential, rpId, salt). Default salt `sha256("mera.prf.salt.v1")`, "will not change across library versions". User verification is **required and not configurable**. Creation = 1 prompt, or 2 prompts on authenticators that don't evaluate PRF at creation (fallback assertion). Each creation makes a **new** passkey (fresh random 32-byte user handle).
- **Reference:** `passkey.d.ts` docs; https://mera.category.xyz/concepts/passkeys-and-prf/
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team

### 3.4 Account model
- **Fact:** How the EVM account is derived
- **Value:** **Application-chosen; Everpiece uses Mera's documented recipe verbatim** (frozen as `EVERPIECE_ACCOUNT_V1`, ESCROW_SPEC §18.6). The exact recipe code:
  ```ts
  import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
  import { wordlist } from "@scure/bip39/wordlists/english.js";
  const seed = mnemonicToSeedSync(entropyToMnemonic(prfOutput, wordlist));   // no passphrase
  const node = HDKey.fromMasterSeed(seed).derive(`m/44'/60'/0'/0/${index}`);  // @scure/bip32
  createSecp256k1SigningSession({ privateKey: node.privateKey }); getEvmAddress(session.publicKey);
  ```
  The result is a **plain EOA** (no smart account, no bundler). Everpiece uses `index = 0`.
- **Reference:** Official repo source `docs/src/content/docs/recipes/create-passkey-accounts.mdx`. It is **byte-identical at tag `v0.2.0` (commit 290cddd2a2f0bdac4b06eda3b34e155ca28acf54) and `main`**. Rendered at https://mera.category.xyz/recipes/create-passkey-accounts/ ; concept page `concepts/entropy-keys-and-accounts.mdx`.
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:** Deps used for vectors: `@scure/bip39 2.4.0`, `@scure/bip32 2.4.0`, `@noble/hashes 2.2.0`, `@noble/curves 2.2.0` (the latter two match Mera 0.2.0's pinned deps). Vectors reproduced by 3 independent implementations: @scure; `cast wallet address --mnemonic … --mnemonic-index 0` (Rust); Mera's own `getEvmAddress` (`evidence/milestone1/account-derivation/`). Consequence: the PRF output is exactly the entropy of a standard 24-word BIP-39 phrase, so anyone who obtains the PRF output has a portable wallet (THREAT_MODEL §F).

### 3.5 RP-ID
- **Fact:** RP-ID binding
- **Value:** Passkeys (and therefore accounts) are bound to the rpId. "After a domain migration, passkey accounts can no longer be reproduced."
- **Reference:** security-model page
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:** **The production domain must be chosen before any real user signs up and must never change.** Preview/staging domains create different accounts. **Target rpId: `everpiece.xyz` (Maris, 2026-09-29). NOT frozen.** Freeze and onboard real users only after Maris controls the domain and HTTPS is live. TODO(VERIFY): domain ownership + HTTPS deployment.

### 3.6 Signing sessions / prompts
- **Fact:** Prompt-per-action behavior
- **Value:** A session holds the private key in memory and signs **without prompts** until `end()`. Prompts happen only on ceremonies (PRF evaluation). Docs: apps that sign occasionally should hold no session and re-run the ceremony per signature.
- **Reference:** https://mera.category.xyz/concepts/signing-sessions/ ; `viem.d.ts`
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:** "Prompt per money action" is an **Everpiece policy choice**, not a Mera guarantee. Proposed policy: one ceremony per money action (create / claim / cancel), end session immediately after signing.

### 3.7 Platform / browser support
- **Fact:** PRF-capable stacks
- **Value:** iCloud Keychain on Safari iOS 18+/macOS 15+; Google Password Manager on Chrome/Android and Edge/Android; GPM on desktop Chrome 132+ (signed-in); iCloud Keychain on Chrome macOS 15+ (132+) and Firefox macOS 15+ (139+); Windows Password Manager on Edge/Win11 25H2+ and Chrome 147+; 1Password ≥2.26.1; YubiKey 5.2+ on Chrome 116+; Proton Pass on Chrome desktop. **Not supported:** Chrome desktop local-profile authenticator, Bitwarden and Dashlane on Chrome desktop. Third-party password managers intercepting WebAuthn can force a non-PRF store → `PRF_UNAVAILABLE` after a passkey was created. React Native: iOS 18+, Android 9+.
- **Reference:** https://mera.category.xyz/authenticator-support/
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:** **Not documented:** WhatsApp / Telegram in-app WebViews. TODO(VERIFY on real devices): WebView PRF support, budget-Android + GPM flow, fragment survival on "open in browser" handoff.

### 3.8 Security model / recovery
- **Fact:** Key exposure and recovery
- **Value:** Derived keys live in page JS memory; any script on the page (XSS, malicious dependency) can read PRF output and live sessions. Losing the passkey (deleted, not synced, provider account lost, domain changed, overwritten) loses the account unless the app provided an export/backup path.
- **Reference:** https://mera.category.xyz/concepts/security-model/ ; passkey-accounts page
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:** Everpiece needs strict CSP, minimal third-party JS on signing routes, and a recovery story (THREAT_MODEL §F).

---

## 4. Other verified facts

### 4.1 Envio supports Monad mainnet
- **Fact:** Envio indexing support for Monad chain 143
- **Value:** "First-class support · Mainnet · Chain ID 143 — HyperSync, HyperRPC, and HyperIndex all support Monad out of the box."
- **Official source:** https://docs.envio.dev/docs/HyperIndex/monad (linked from https://hackathon.monad.xyz/resources)
- **Explorer / verified-source reference:** n/a
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:** Config syntax read on 2026-09-30 from the pinned package itself; see §4.7.

### 4.7 Envio HyperIndex 3.12.1: config keys, platforms, test framework
- **Fact:** How the pinned Envio version is configured, where it runs, and how it tests
- **Value:**
  - npm `envio` dist-tags on 2026-09-30: `latest` 3.12.1, `next` 3.13.0. Pinned exactly: `envio@3.12.1`; engines `node >=22`.
  - Native binaries (optionalDependencies) exist only for linux-x64, linux-x64-musl, linux-arm64, darwin-x64 and darwin-arm64. **No Windows build:** `envio codegen` on native Windows fails with "Cannot read properties of null (reading 'runCli')". Runs in WSL.
  - Config keys come from `node_modules/envio/evm.schema.json`:
    - top level: `name`, `chains` (required), `contracts`, `schema`, `handlers`, `rollback_on_reorg` (default true), `field_selection.transaction_fields`, `address_format` (checksum|lowercase), `bytes_type` (hex|uint8array);
    - per chain: `id`, `start_block` (required), `block_lag` ("blocks behind the chain head that the indexer should lag"), `max_reorg_depth`, `rpc` (`for: sync|fallback|realtime`), `contracts[].address`;
    - events are human-readable signatures.
  - `${ENV_VAR}` interpolation works in `start_block`, `block_lag` and a *quoted* `address` (verified by codegen). An unquoted `0x…` address fails to parse ("did not match any variant of untagged enum SingleOrList").
  - Handlers: `indexer.onEvent({ contract, event }, async ({ event, context }) => …)`; `context.<Entity>.get/getOrThrow/getWhere/getOrCreate/set`; relations are set as `<field>_id` (from `index.d.ts`).
  - Tests: `createTestIndexer().process({ chains: { <id>: { simulate: [...] } } })` runs the real handlers in memory (no Docker, no DB, no network). The simulated head is `endBlock` (default: the max simulated block).
    - `block_lag > 0` therefore makes `process()` never finish (fetch ceiling = head − lag), which we hit and confirmed in `src/sources/SimulateSource.res`. Tests set the lag to 0.
  - Local `envio dev` needs Docker or Podman. Envio Cloud deploys via the "Envio Deployments" GitHub App on push.
- **Official source:** npm package `envio@3.12.1` (`evm.schema.json`, `index.d.ts`, `src/TestIndexer.res`, `src/sources/SimulateSource.res`); https://docs.envio.dev/docs/HyperIndex/running-locally ; https://docs.envio.dev/docs/HyperIndex/hosted-service ; https://docs.envio.dev/blog/envio-developer-update-april-2026
- **Explorer / verified-source reference:** n/a (no deployed escrow yet)
- **Date checked:** 2026-09-30
- **Checked by:** Everpiece team
- **Notes:**
  - Finality mapping: Monad `finalized` = head − 2 (§1.14), so production uses `block_lag: 3` (one block of margin) with `rollback_on_reorg: true`. This is a block count, not the `finalized` tag.
  - TODO(VERIFY): whether HyperIndex can follow the `finalized` tag directly.
  - TODO(VERIFY): HyperSync's own lag on Monad against the head, on the real chain.

### 4.8 Resend email API (claim-code email channel)
- **Fact:** How to send one transactional email with Resend, and its limits
- **Value:**
  - `POST https://api.resend.com/emails` with `Authorization: Bearer re_…`.
  - Required fields: `from` ("Name <email@example.com>"), `to` (string or array, max 50) and `subject`. `text` and `html` are optional. Success returns `{ "id": "<uuid>" }`.
  - "All API requests must include a User-Agent header." Otherwise the request is rejected with 403.
  - `Idempotency-Key` header: at most 256 characters, unique per request, expires after 24 h.
  - Errors used by the adapter:
    - 401 `missing_api_key`;
    - 403 `validation_error` (own-address-only without a verified domain; domain not verified);
    - 429 `rate_limit_exceeded`, `daily_quota_exceeded`, `monthly_quota_exceeded`;
    - 5xx.
    The error JSON shape is **not documented**; the adapter only reads an optional string `name`.
  - Default rate limit: 10 requests per second per team.
  - A verified domain is mandatory. Resend recommends a subdomain (e.g. `updates.example.com`) to isolate reputation.
    - The dashboard generates the DNS records: DKIM TXT at `resend._domainkey[.sub]`, plus SPF and MX for the return-path subdomain (default `send.`).
  - Free plan: 3,000 emails per month, "limited to 100 emails per day", 3 domains. Pro: $20/month for 50,000.
- **Official source:** https://resend.com/docs/api-reference/emails/send-email ; https://resend.com/docs/api-reference/introduction ; https://resend.com/docs/api-reference/errors ; https://resend.com/docs/dashboard/domains/introduction ; https://resend.com/docs/add-a-domain ; https://resend.com/pricing
- **Explorer / verified-source reference:** n/a
- **Date checked:** 2026-09-30
- **Checked by:** Everpiece team
- **Notes:**
  - Adapter: `server/claims/src/providers.ts` `ResendEmailProvider`. Everpiece generates and checks the code (LocalOtp); the idempotency key is the OTP ref.
  - The API key format was seen only as `re_…` in the docs, so config checks just the prefix.
  - **Live-verified 2026-09-30:**
    - `mail.everpiece.xyz` was verified in Resend: DKIM TXT, two SPF **CNAMEs** (`rsend.mail`→`rsend.forge.rmta.net`, `send.mail`→`send.forge.rmta.net`) and DMARC `p=none`. That's CNAMEs, not the TXT and MX we expected, and receiving was not needed.
    - A real claim code from `codes@mail.everpiece.xyz` reached a Gmail inbox (Primary tab), and the recipient claimed $5 with it on the test stack.
  - Real error bodies are JSON `{ name, message }`: 403 `validation_error` "The mail.everpiece.xyz domain is not verified…"; 401 `validation_error` "API key is invalid".
  - TODO(VERIFY): delivery to Yahoo and Outlook, and to Nigerian ISP mailboxes.
  - TODO(VERIFY): inbox placement at Gmail and Yahoo (with DMARC set).

### 4.9 Monad testnet (10143) — RPC, faucet, AUSD absent
- **Fact:** What Everpiece can use on Monad testnet
- **Value:**
  - Chain ID 10143 (`0x279f`, confirmed live 2026-10-02 on two RPCs).
    - RPCs: `https://testnet-rpc.monad.xyz` (QuickNode, 50 rps; 25 rps for eth_call/estimateGas), `https://rpc.ankr.com/monad_testnet`, `https://rpc-testnet.monadinfra.com` (20 rps).
    - Explorers: testnet.monadvision.com, testnet.monadscan.com. Faucet: https://faucet.monad.xyz. "testnet was reset from genesis on 2025-12-16".
  - **AUSD is not on testnet:** `eth_getCode(0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a)` = `0x` on both RPCs.
  - The official testnet token list (monad-crypto/token-list `tokenlist-testnet.json`) has 4 tokens; the only dollar token is **USDC** `0x534b2f3A21130d7a60830c2Df862319e593943A3` (6 decimals).
  - **EverpieceEscrow is AUSD-specific.** It calls `AUSD.isReceiveWithAuthorizationUpgraded()` before funding and fails closed. A token without that function (e.g. USDC) makes every `createPayment` revert.
  - TODO(VERIFY): whether testnet USDC implements EIP-3009 `receiveWithAuthorization` (Circle FiatToken).
  - **The public testnet RPC limits `eth_getLogs` to 100 blocks** ("eth_getLogs is limited to a 100 range", seen live 2026-10-02). The indexer caps its window at 90 blocks.
  - **Everpiece testnet deployment (2026-10-02)**, both finalized; read back at finalized: token, owner, approver, minter, decimals, flag:
    - TestDollar `0xd073fD9a4361a18aa41f599d8A6ea96033376667` (block 67538098, tx `0x2ca90a43…3f2c`);
    - EverpieceEscrow `0x94A25e4cE211D94709915100bd6E8CbC4477BFD5` (block 67538102, tx `0xc60211e9…f63b`).
    - Owner `0x61Acc84c…701a`, approver `0x8e87D298…593c`, relayer `0x181b4Ff1…a467`, deployer/minter `0xc90551F8…8eAe`.
    - Explorer: https://testnet.monadscan.com/address/0x94A25e4cE211D94709915100bd6E8CbC4477BFD5
- **Official source:** https://docs.monad.xyz/developer-essentials/testnets ; https://github.com/monad-crypto/token-list ; live `eth_chainId` / `eth_getCode`
- **Date checked:** 2026-10-02
- **Checked by:** Everpiece team

### 4.10 Unlink (private transfers) on Monad
- **Fact:** What Unlink offers and on which Monad network
- **Value:**
  - Supported chains: **Monad Testnet 10143 "Available"**; **Monad mainnet 143 "Contact us for access"**. SDK `@unlink-xyz/sdk` (`/browser`, `/client`, `/admin`).
  - Operations: deposit, transfer, withdraw, execute.
  - Privacy:
    - **Transfer:** "Sender, recipient, and amount are hidden by the proof"; the token type is also private.
    - **Deposit:** amount, token and sender are public.
    - **Withdraw and execute:** amount, token and recipient are public; the sender is private.
  - Relayer: "Transfers and withdrawals are submitted by Unlink's relayer"; deposits need user gas; execute uses a sponsored ERC-4337 UserOperation.
  - Accounts:
    - deterministic from an EVM signature: `buildDeriveSeedMessage({appId, chainId})` → `personal_sign` → `account.fromEthereumSignature`, then HKDF-SHA256 to a 64-byte seed;
    - also `fromMnemonic`, `fromSeed`, `fromKeys`;
    - addresses are Bech32m `unlink1…`;
    - encrypted `userStorage` with passphrase or **WebAuthn PRF** unlock.
  - Transfer status: `confirmed | processed | failed`; "prefer processed" before spending.
  - Test tokens come from `requestTestTokens()` / `requestPrivateTokens()`, "hosted mock token" addresses shown in the Unlink dashboard.
  - **Not documented:** escrow, cancel, expiry or conditional release of a private transfer; per-chain pool addresses; supported-token list; audit status. Treat private transfers as final until proven otherwise.
- **Official source:** https://docs.unlink.xyz/ (supported-chains, how-unlink-works, accounts-and-keys, transfer, faucet); https://monad.xyz/blog/privacy-comes-to-monad-with-unlink (Monad blog, published 2026-06-25: "Unlink … is now live on Monad"; the contract "verifies each operation without learning the sender, the recipient, or the amount of a private transfer")
- **Correction (2026-10-02):** the raw https://docs.monad.xyz/tooling-and-infra/privacy.md lists **only TACEO Merces** (§4.11), not Unlink. An earlier summarised fetch was wrong about that. Unlink's Monad support rests on Unlink's own docs and Monad's blog.
- **Date checked:** 2026-10-02
- **Checked by:** Everpiece team
- **Notes:** TODO(VERIFY): the dashboard/appId requirement, whether arbitrary ERC-20s (an Everpiece test dollar) can be deposited, Mera EOA `personal_sign` compatibility, and audit status. Master §28.2 gate items 6–13 must be proven on testnet before launch.

### 4.11 TACEO Merces (private ERC-20 balances) on Monad
- **Fact:** The privacy provider on Monad's official privacy page
- **Value:**
  - Wraps existing ERC-20s into private balances. Balances and identifiers are secret-shared across independent MPC nodes (the TACEO Network), and every state change is verified on-chain by a collaborative ZK proof (coSNARK).
  - SDK `@taceo/merces-client` (with CLI `taceo-merces-client --chain monad`).
  - **Mainnet:** "Supported (limited access)": **USDC only** (`0x754704Bc059F8C67012fEd69BC8A327a5aafb603`); Merces `0x9Dd5DE40592AdfcDD60F0f3fF3B014553998f7c1`; ID Registry `0xF55DFe8242ec117F44Acd932adb5C233b582A04a`.
    - A **compliance attestation is required** for registration, deposit and withdraw.
    - ANON group: Fee=0, **Max 1 USDC per tx**, 35 txs per epoch, **max 100 members**.
  - **Testnet:** "Supported (demo)": a cross-chain OFT demo via LayerZero with **its own test token** `0xb1ed36367611392c04d14f80812d86749dc02d9c`; Merces `0x654d4c73473e060a1de5888fab34bcb41af073cf`; ID Registry `0x3cae9f1934b9079212531673cafc070a2e44bdc8`; access "Via OFT SDK".
  - **Not stated:** support for arbitrary ERC-20s (e.g. TestDollar), transfer finality, cancel or escrow, browser key management.
  - Trust model: privacy relies on the MPC nodes not colluding.
  - **Live on-chain (2026-10-02):** Monad testnet code exists at Merces `0x654d…73cf` (23,781 B), ID registry `0x3cae…dc8` (7,812 B) and token `0xb1ed…2d9c` (4,042 B: name/symbol "USDT0", **18 decimals**). On mainnet, `0x9Dd5…f7c1` and `0xF55D…A04a` are 135-byte proxies.
  - **SDK `@taceo/merces-client@0.1.1` (MIT; read from the package, dist/index.js and README):**
    - **Every action is an on-chain tx sent by the user's own walletClient** (`register`, `depositWithPermit`, `transfer`, `withdraw`), so the user needs native gas. The SDK has no relayer path, and the submitter address is public.
    - Transfer: "Sender, receiver, and amount are all hidden behind commitments". Recipients are registered EVM addresses.
    - Deposit needs an **ERC-2612 permit** on the token. Each Merces deployment is bound to **one** ERC-20.
    - The auth secret comes from an EIP-712 signature (`deriveAuthSecret`) and acts as a spending credential.
    - Node ≥ 22; ships ~11 MB of circuits (snarkjs proving).
    - The only Monad preset (`--chain monad`) is **mainnet** (USDC, compliance URL, query nodes `query.node{0,1,2}.usdc.monad.merces.taceo.network`). **Testnet query-node URLs are not published** in the SDK or README.
  - TODO(VERIFY): testnet node URLs, how to obtain the testnet token, and whether the Merces contract accepts relayed submissions — ask TACEO.
- **Official source:** https://docs.monad.xyz/tooling-and-infra/privacy.md ; https://docs.taceo.io/docs/start-here/deployments-and-status/ ; https://docs.taceo.io/docs/finance-solutions/overview/
- **Date checked:** 2026-10-02
- **Checked by:** Everpiece team
- **Re-checked 2026-10-06** (deployments-and-status page): unchanged. Mainnet "limited users, volume caps", SDK-only, USDC only; ANON group 1 USDC/tx, 35 txs/epoch, 100 members; compliance service required; testnet is still only the LayerZero OFT demo.
- **Also (TACEO launch post, 2026-09-24, https://core.taceo.io/articles/merces-mainnet/):** live on **Monad and World Chain mainnet**. Testnets listed are Arc, Base, Ethereum, Plasma and Stable; **Monad testnet is not listed** there. Tapa is TACEO's internal payments app on Monad mainnet. No relayer or gas sponsorship is mentioned. Builders contact TACEO for integration.

### 4.12 Monad privacy landscape (re-checked 2026-10-02)
- **Fact:** Which private-payment routes Monad itself points to
- **Value:**
  - **Monad docs privacy page:** still lists **only TACEO Merces** (§4.11; re-fetched raw .md 2026-10-02).
  - **Monad blog:** one privacy post, **Unlink** (§4.10, 2026-06-25).
  - **(Superseded by the 2026-10-06 reveal below.)** Monad's official X teased "Privacy is coming" / "An open network doesn't require open books", with a reveal on **2026-10-06** at the Monad Foundation's "Open" summit in Singapore. Press reports say the technology comes from **Category Labs** (formerly Monad Labs). **No technical spec, scope or timeline has been published.** TODO(VERIFY) on 2026-10-06 from Monad's official channels; do not design against it before then.
  - **Not found on Monad** in official sources: Railgun, Hinkal, Privacy Pools, Aztec, Zama/FHE. Aztec is its own L2; Zama needs an FHE coprocessor.
  - **Revealed 2026-10-06: Monad Private Settlement** (Category, https://www.category.xyz/monad-private-settlement; page dated September 2026):
    - What it is: institution-run "private execution & settlement domains" on the Monad L1, created via a hub contract. "Transactions, state, and contract code within a Private Settlement domain are encrypted." User transactions are encrypted and sequenced by L1; settlement is atomic ("all legs settle, or none does"); domains reach pooled L1 liquidity; EVM-compatible.
    - Audience: "banks, fund, or asset manager" use cases (client funds, treasury, quoting, trading).
    - Not stated: launch date, testnet, waitlist, SDK/API, supported tokens (the domain creator chooses "which L1 tokens will be available"), or any consumer/payments-app access. The page marks features "under development or subject to change".
    - **Consequence for Everpiece:** not usable now. Everpiece would be a *user* of a domain someone else runs, not a domain operator. Revisit when Category publishes access, tokens (AUSD?) and dates. Private mode stays on the Unlink path (§4.10), which is blocked on the Unlink dashboard/API key.
  - **Self-built option:** ERC-5564 stealth addresses + ERC-6538 registry are a final Ethereum standard. They hide **who is the recipient** (a one-time address), not the amount or the sender. They need no third party and work on any EVM chain, including Monad testnet.
- **Official source:** https://docs.monad.xyz/tooling-and-infra/privacy.md ; https://monad.xyz/blog/privacy-comes-to-monad-with-unlink ; https://ercs.ethereum.org/ERCS/erc-5564 ; press: https://www.kucoin.com/news/flash/monad-announces-privacy-update-for-october-6-mon-token-surges-18
- **Date checked:** 2026-10-02
- **Checked by:** Everpiece team

### 4.13 HPKE for @username messages (RFC 9180, hpke-js)
- **Fact:** The standard and the library used to seal a message secret to a recipient's X25519 key
- **Value:**
  - RFC 9180 HPKE, base mode. Test vector **A.1.1** (DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM): copied verbatim from the RFC text into `packages/shared/test/messageKey.test.ts`; the pinned library reproduces pkRm/skRm from ikmR, enc from ikmE, and ciphertext 0.
  - §7.1.4: X25519 implementations must reject an all-zero DH output. The library rejects all-zero, 1 and an order-8 point (EncapError); regression test.
  - Library: `@hpke/core` **1.9.0** + `@hpke/dhkem-x25519` **1.8.0** (+ `@hpke/common` 1.10.1), pinned exactly.
    - Its X25519 file states it is "based on noble-curves". The README says the module "is implemented by using @noble/curves".
    - AES-GCM comes from Web Crypto.
    - The project says it passes the RFC test vectors and "has not been formally audited".
  - noble-curves: Trail of Bits audit, January 2023 (`audit/2023-01-trailofbits-audit-curves.pdf` in the repo).
- **Official source:** https://www.rfc-editor.org/rfc/rfc9180.txt ; https://jsr.io/@hpke/hpke-js/doc ; https://paulmillr.com/noble/ ; installed package sources (`node_modules/@hpke/*`)
- **Date checked:** 2026-10-02
- **Checked by:** Everpiece team
- **Notes:** No formally audited JavaScript HPKE was found. Risk accepted and mitigated (THREAT_MODEL K.1 #4).

### 4.14 Cross-chain funding: Aurora Intents, USDC on Monad, Agora AUSD/USDC (checked 2026-10-06)

- **Aurora Intents** (docs.intents.aurora.dev):
  - Supported chains include **Monad**, "✅ Supported" as both source and destination (Intents Connect and Intents Deposits pages). Mainnet only: no testnet is listed.
  - API base `https://intents-api.aurora.dev/api`; the API key is a path segment: `GET /tokens/{apiKey}`, `POST /quote/{apiKey}`, `POST /deposit/submit/{apiKey}` (`txHash`, `depositAddress`), `GET /status/{apiKey}?depositAddress=`.
  - `swapType` ∈ EXACT_INPUT, EXACT_OUTPUT, FLEX_INPUT, ANY_INPUT. EXACT_OUTPUT: `amountOut` fixed; slippage applies to the input; less than `minAmountIn` is refunded by the deadline; excess is refunded to `refundTo` after the swap.
  - `refundType`/`depositType` ORIGIN_CHAIN | INTENTS | CONFIDENTIAL_INTENTS; `recipientType` DESTINATION_CHAIN | INTENTS | CONFIDENTIAL_INTENTS.
  - Statuses: KNOWN_DEPOSIT_TX, PENDING_DEPOSIT, INCOMPLETE_DEPOSIT, PROCESSING, SUCCESS, REFUNDED, FAILED.
  - Fees: "split 60/40 between the Integrator (60%) and Aurora (40%)"; floor on stables "max(2 bps, 40% of the Integrator fee)"; maximum 500 bps. Keys come from Intents Studio (studio.aurora.dev) and are "not sensitive".
  - Field types: the same names and enums as NEAR Intents 1Click's published OpenAPI (`1click.chaindefuser.com/docs/v0/openapi.yaml`), used as the type reference. TODO(VERIFY): Aurora's own token list with a real key (the public 1Click list has Monad MON, USDC and USDT0 only; **no AUSD**).
- **USDC on Monad mainnet** `0x754704Bc059F8C67012fEd69BC8A327a5aafb603`: on-chain `name()` "USDC", `symbol()` "USDC", `decimals()` 6, `version()` "2"; `DOMAIN_SEPARATOR()` equals EIP-712(name "USDC", version "2", chainId 143, this address), so ERC-2612 permits are signed in that domain. The 1Click token list maps Monad USDC (`nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx`) to this contract.
- **Agora AUSD/USDC pair, Monad mainnet** `0xf33286E3222D1c829dACeac48c0Ec651F6452470` (Agora "Instant Settlement → Protocol Deployments"; factory `0x8468587Af422ad440F58a57E955eCA6A970b5375`).
  - On-chain: `name()` "AUSD/USDC", `token0()` AUSD, `token1()` USDC; `getAmountsIn(25 AUSD, [USDC, AUSD])` = 25 USDC (2026-10-06).
  - `APPROVED_SWAPPER` is required (77 members, granted by Agora; `WHITELISTER_ROLE` holder `0x4B95a6990ec8B7dE1fAB83dF36f4f63FDE464fFC`). **EverpiecePay must be approved by Agora before mainnet USDC conversions.**
  - Fork-proven (`contracts/test/fork/RelayerGas.t.sol`): EverpiecePay placed at an already-approved wallet converts USDC → exactly 25.000000 AUSD with a USDC permit; worst-case gas 520,398.

### 4.15 Last-mile payout: Paycrest (stablecoin → NGN bank) and Circle CCTP V2 on Monad (checked 2026-10-06)

- **Paycrest Sender API v2** (https://docs.paycrest.io/implementation-guides/sender-api-integration):
  - Base `https://api.paycrest.io`; header `API-Key`; credentials (API Key + API Secret) after sign-up at app.paycrest.io **and KYB**.
  - **Mainnet only:** "Paycrest runs on mainnet only. Test with the minimum order size: $0.50 on any supported chain."
  - Off-ramp order: `POST /v2/sender/orders` with
    - `amount`;
    - `source {type:"crypto", currency (USDT|USDC), network (base|starknet|tron|solana), refundAddress}`;
    - `destination {type:"fiat", currency:"NGN", recipient {institution (e.g. "GTBINGLA"), accountIdentifier, accountName, memo}}`;
    - `reference`; optional `senderFee`/`senderFeePercent` (+ `senderFeeAddress`); optional `destination.providerIds` (≤ 3).
  - The response's `providerAccount {receiveAddress, validUntil, amountToTransfer, currency}`: send exactly `amountToTransfer` (= amount + senderFee + transactionFee) before `validUntil`.
  - `GET /v2/sender/orders/{id}`; `GET /v2/rates/{network}/{from}/{amount}/{to}` (public; `data.sell.rate`); `POST /v2/verify-account {institution, accountIdentifier}` → canonical account name (or "OK" when lookup is unavailable); `GET /institutions/{currency}`.
  - Statuses/events: `initiated`, `payment_order.deposited`, `pending`, **`payment_order.validated` = "fiat payout confirmed by provider" (the off-ramp completion point)**, `payment_order.settling`, `settled`, `payment_order.refunding`, `refunded`, `expired` (no deposit before `validUntil`).
  - Refunds go to `source.refundAddress`. Webhooks are signed: `X-Paycrest-Signature` = hex HMAC-SHA256(API Secret, raw body), compared timing-safe on the UTF-8 hex strings.
  - **Monad is not a Paycrest network.**
  - TODO(VERIFY): whether the NGN rate is locked at order creation (affects "exactly ₦X"), and the refund window length.
- **Circle CCTP V2** (https://developers.circle.com/cctp/cctp-supported-blockchains, /evm-smart-contracts; launch post dated 2025-11-24, https://www.circle.com/blog/now-available-usdc-cctp-wallets-and-contracts-on-monad):
  - Monad = **domain 15** (mainnet and testnet); Base = domain 6. Standard Transfer on Monad ✅; Fast Transfer "N/A" (standard attestation is already fast). "Upfront fees aren't supported on Monad Testnet".
  - Mainnet: TokenMessengerV2 `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`, MessageTransmitterV2 `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`, TokenMinterV2 `0xfd78EE919681417d192449715b2594ab58f5D002`.
  - Testnet: TokenMessengerV2 `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`, MessageTransmitterV2 `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`, TokenMinterV2 `0xb43db544E2c27092c107639Ad201b3dEfAbcF192`.
  - **On-chain 2026-10-06:** code present at all six addresses; MessageTransmitterV2 `localDomain()` = 15 on both networks.
  - `depositForBurn(amount, destinationDomain, mintRecipient, burnToken, destinationCaller, maxFee, minFinalityThreshold)`; minFinalityThreshold 1000 = fast, 2000 = standard.
- **Yellow Card** (backup payout provider, bank + mobile money, partner sandbox): not verified yet. TODO(VERIFY) from its API docs before any use.

### 4.2 Hackathon window
- **Fact:** Metropolis intake window
- **Value:** "Intake · Open 1 Sep to 13 Oct" (public landing page). **No time of day or timezone is shown.**
- **Official source:** https://hackathon.monad.xyz/
- **Explorer / verified-source reference:** n/a
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:** TODO(VERIFY): exact submission time and timezone from the logged-in dashboard (Maris). Until then, treat Oct 12 as the hard internal deadline.

### 4.3 Safe multisig on Monad mainnet (escrow owner candidate, D8)
- **Fact:** A Monad-compatible multisig exists on chain 143
- **Value:**
  - Safe **v1.4.1** canonical deployments: `SafeL2` `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762`, `Safe` `0x41675C099F32341bf84BFc5382aF534df5C7461a`, `SafeProxyFactory` `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67`, `CompatibilityFallbackHandler` `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99`, `MultiSendCallOnly` `0x9641d764fc13c8B624c04430C7356C1C7C8102e2`.
  - Safe v1.3.0 (canonical + EIP-155) are also deployed.
- **Official source:**
  - Monad docs, Multisig Wallets (mainnet tab lists Safe → https://app.safe.global): https://docs.monad.xyz/tooling-and-infra/wallets/multisig-wallets
  - Monad protocol registry: https://github.com/monad-crypto/protocols/blob/main/mainnet/safe.jsonc
  - Safe registry: https://github.com/safe-global/safe-deployments (v1.4.1 `networkAddresses["143"] = "canonical"`)
- **Explorer / verified-source reference:** On-chain `keccak256(eth_getCode)` on `rpc.monad.xyz` **matches the registry `codeHash`** for SafeL2 (24,421 B, `0xb1f9…81ff`), SafeProxyFactory, CompatibilityFallbackHandler and MultiSendCallOnly.
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:**
  - The Safe web UI / Transaction Service support for 143 is listed by Monad docs but not yet exercised. TODO(VERIFY) by creating a test Safe before ownership transfer.
  - Ownership handoff: the current owner calls `transferOwnership(safe)`; the Safe then executes `acceptOwnership()` (Ownable2Step). The Safe gets exactly the same minimal powers; nothing new is added (D8).

### 4.4 Twilio Verify (SMS OTP provider candidate)
- **Fact:** API used by `server/claims` TwilioVerifyProvider
- **Value:**
  - Start: `POST https://verify.twilio.com/v2/Services/{ServiceSid}/Verifications` with `To`, `Channel` (`sms` | `call` | `email` | `whatsapp` | `sna` | `auto`) → `sid` (`VE…`), `status`.
  - Check: `POST …/Services/{ServiceSid}/VerificationCheck` with `To` (or `VerificationSid`) + `Code` (4–10 chars) → `status` ∈ `pending | approved | canceled | max_attempts_reached | deleted | failed | expired`.
  - A verification is **deleted** after 10 min, on approval, or at max check attempts; a later check returns **404**. A new verification can then be started, so there is no permanent lock.
  - Auth: HTTP Basic (Account SID + Auth Token, or API Key SID + secret). Bodies are `application/x-www-form-urlencoded`; replies are JSON.
- **Official source:** https://www.twilio.com/docs/verify/api/verification ; https://www.twilio.com/docs/verify/api/verification-check ; https://www.twilio.com/docs/usage/requests-to-twilio
- **Explorer / verified-source reference:** n/a (docs only; no live account yet)
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:**
  - Delivery rules (Twilio SMS guidelines):
    - **Nigeria:** alphanumeric sender ID needs pre-registration: international ~3 weeks, domestic 2–3 weeks (major networks only). "Numeric International sender ID is not supported to the MTN, Airtel and 9 Mobile networks". The DND registry "can block notifications and OTPs" through aggressive telco filtering. No two-way SMS. Sources: https://www.twilio.com/en-us/guidelines/ng/sms, and Twilio Help "Alphanumeric Sender ID for Verify" (Nigeria is pre-registration-required for Verify).
    - **UK:** dynamic alphanumeric sender IDs are allowed; generic IDs ("OTP", "2FA", "Verify", "SMS", …) are blocked; protected IDs need registration. Source: https://www.twilio.com/en-us/guidelines/gb/sms
  - Pricing, rate limits and actual NG/UK delivery: TODO(VERIFY) via a live account and test sends.
  - **Live on a TRIAL account (2026-10-01):**
    - The console "Try out Verify" sent a code that **arrived on the owner's Airtel NG number**, and the check returned approved.
    - The trial has a default Verify Service ("Try It Out Verify Service", `code_length` 6). A Standard API key can fetch it: `GET /v2/Services/{sid}` → 200.
    - The test stack now runs `SMS_PROVIDER=twilio` against that service.
    - Trial limits: 40 verifications, only to the trial's verified recipients (at most 5), sign-up country only.

### 4.5 Termii Token API (Nigeria-focused SMS OTP provider candidate)
- **Fact:** API used by `server/claims` TermiiProvider
- **Value:**
  - Send: `POST https://{BASE_URL}/api/sms/otp/send` with `api_key`, `message_type` (NUMERIC|ALPHANUMERIC), `to` (international format), `from` (**approved** sender ID), `channel` (`dnd` | `generic`), `pin_attempts`, `pin_time_to_live` (minutes), `pin_length` (4–8), `pin_placeholder`, `message_text`, `pin_type` → `pinId`, `to`, `smsStatus`.
  - Verify: `POST https://{BASE_URL}/api/sms/otp/verify` with `api_key`, `pin_id`, `pin` → `pinId`, `verified` ("True" in the example), `msisdn`.
  - `BASE_URL` is account-specific (dashboard).
- **Official source:** https://developers.termii.com/send-token ; https://developers.termii.com/verify-token
- **Explorer / verified-source reference:** n/a (docs only)
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:** TODO(VERIFY) before enabling:
  - request body encoding (the adapter sends JSON);
  - whether `to` takes a leading "+" (the adapter strips it);
  - the failed/expired `verified` response shape (the adapter treats anything but true/"True" as not approved, and "Expired" as dead);
  - sender-ID approval time;
  - pricing.

### 4.6 Twilio Programmable Messaging (plain SMS) and trial restrictions
- **Fact:** API used by `server/claims` TwilioSmsProvider, and what a trial account can do
- **Value:**
  - Send: `POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json` with `To`, `From` (or `MessagingServiceSid`), `Body` → `sid`, `status`, `error_code`, `error_message`.
  - Fetch: `GET …/Accounts/{AccountSid}/Messages/{Sid}.json`.
  - Statuses: queued, sending, sent, failed, delivered, undelivered, …
  - API Key SID + secret works for auth, with the AccountSid kept in the URL.
  - **Trial accounts:** "You must use Twilio-provided templates. Custom message bodies, email content, and WhatsApp templates aren't available during trial."
  - **Verify Services also require an upgraded account.**
  - Upgrade: minimum starting balance $20 (options $20/$50/$100/custom), with auto-recharge pre-enabled at $50.
- **Official source:** https://www.twilio.com/docs/messaging/api/message-resource ; https://www.twilio.com/docs/messaging/guides/how-to-use-your-free-trial-account ; https://www.twilio.com/en-us/verify/pricing ($0.05 per successful verification + channel fees)
- **Explorer / verified-source reference:** Live, owner's trial account, 2026-09-29, two sends refused, **nothing sent**:
  - a Restricted key with only Verify permissions → `HTTP 401, 8001 "actor doesn't have any assertions"`;
  - after granting Messaging → `HTTP 400, 572006 "Invalid template name. Trial accounts can only use predefined SMS templates."`
  - Seen in the owner's Twilio console: "Verify … Upgrade to create and manage your own Verify service"; the upgrade screen shows a $20 minimum with auto-recharge checked.
- **Date checked:** 2026-09-29
- **Checked by:** Everpiece team
- **Notes:**
  - Everpiece OTP texts (custom body, or Verify) need an upgraded Twilio account.
  - The trial console "Send an SMS" with a predefined template can still be used to test **delivery** to a Nigerian number for free.
  - **Trial units (Twilio docs, read 2026-10-01; https://www.twilio.com/docs/usage/trials):**
    - Product units rather than dollars: "100 SMS messages, 3,000 emails, and 75 voice minutes", and "Verify functions during trial with 40 verifications".
    - At most **5 verified recipients**; "SMS messages and voice calls are restricted to your sign-up country"; the trial ends 30 days after sign-up.
    - Trial SMS must use Twilio-provided templates (order confirmations, appointment reminders); no documented OTP template.
    - This contradicts the console message seen on 2026-09-29 ("Upgrade to create and manage your own Verify service"). TODO(VERIFY): whether a trial account can create or use a Verify Service.
  - **Owner-reported (2026-10-01):** a Twilio trial test SMS **was received** on the owner's Nigerian Airtel number (+234 902…), sent from a Twilio number. In practice delivery to Airtel NG worked on that route, despite the guideline about numeric senders.
    - TODO(VERIFY): which sender and route it used (console message log); whether a custom-body OTP from `twilio-sms` delivers the same way after upgrading; MTN, Glo and 9mobile.

## 5. Pending verification

- TODO(VERIFY): exact submission time/timezone (dashboard) · Agora bounty text (BOUNTIES.md).
- TODO(VERIFY): Safe UI/Transaction Service on 143 via a test Safe, before transferring escrow ownership (see §4.3).
- TODO(VERIFY): `@noble/curves` random secp256k1 key API name in the installed version (link package, Oct 4).
- TODO(VERIFY): USDC / CCTP on Monad — Circle docs (only if cash-out via CCTP is pursued).
