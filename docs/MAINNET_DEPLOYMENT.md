# Monad mainnet deployment (chain 143) — 2026-10-11

Deployed by the owner's explicit GO, from the deployer wallet, with `contracts/script/DeployEverpieceMainnetV2.s.sol`.
Verified at the `finalized` block: code present, constructor wiring read back.

| Contract | Address |
|---|---|
| EverpieceStableConverter | `0xc0F7EaA59e0A6aA001A6311F7f6b9efB57f0f82C` |
| EverpiecePayV2 | `0x29D15Bb918589B9dF84EdE5c3B5A7a3Ec89c8eb5` |
| EverpieceEscrowUsdc | `0x70ab17cFEe72fFd49F8C766692067D16965F5AA8` |
| EverpieceEarnUsdc | `0x73e633b0caCCE41cFbB3278F1D100c9e5F7A373D` |
| EverpieceAutomate | `0xEC3F0a726Ad4604B20F71CeD79059e0aAA2f3732` |

| Role | Address |
|---|---|
| Deployer (nonce 5 after the deploy; spent ≈1.24 MON) | `0x519aEBD2B71e9908D5CF3e9d5b8689De648AC35c` |
| Escrow owner (pause, caps ≤ $500 / $5,000, rotate approver; never moves funds) | `0x803376Fb273cBC5B5dceb74741f47EF595699d8E` |
| Claim approver | `0xa545e02300018A674e9A3421DB5CccdDe0C4B4c5` |
| Relayer / Automate executor | `0x8AEDdD970373eB53Dc318f85a7854a444B13F2C6` |

Read back on-chain: PayV2 converter = the converter above; USDC kind 1, AUSD kind 2; pair USDC↔AUSD = Agora `0xf332…2470`;
escrow token = USDC, owner and approver as above; Earn vault waMonUSDC allow-listed; Automate vault asset = USDC.

Not yet done (each needs its own GO): relayer + services configured with these addresses, feature flags, canaries.

## Public app (2026-10-11) — https://app.everpiece.xyz

All on the VPS under `/opt/everpiece-mainnet`, each a separate systemd service bound to 127.0.0.1, fronted by one Caddy site block
(`Caddyfile` backup: `/etc/caddy/Caddyfile.bak-everpiece-mainnet-20261011T200655Z`). The testnet stack and every other project are untouched.

| Service | Port | Memory cap | Notes |
|---|---|---|---|
| `everpiece-mainnet-relayer` | 47310 | 300M | `/svc/relayer/*`; policy caps $20 per payment, $50 per sender per day (beta) |
| `everpiece-mainnet-directory` | 47311 | 200M | `/svc/directory/*`; usernames, payment requests, cross-chain proofs |
| `everpiece-mainnet-web` | 47320 | 400M | Next.js standalone, built on a PC (the VPS is memory-constrained) |

- Passkey RP ID is pinned to `everpiece.xyz` (`NEXT_PUBLIC_RP_ID`): accounts survive any change of subdomain. Never change it once users exist.
- The web app's dollar is USDC (domain "USDC"/"2"); protected sends use EverpieceEscrowUsdc.
- Flags on: USDC and AUSD payments, the DEX converter, Earn. Everything else off. Phone/email sends are hidden (no claims service yet).
- Secrets: only `/opt/everpiece-mainnet/relayer.env` (mode 600): `RELAYER_PRIVATE_KEY`, `RELAYER_INTERNAL_KEY`.
- Not deployed: claims (needs the approver key + SMS/email providers), the indexer (history falls back to this device), the message store, the Automate service, Aurora, private payments, Invest, NGN.

Canaries on mainnet (all passed, $1 each): AUSD direct, USDC direct, USDC escrow create/claim/forward, AUSD→USDC conversion via Uniswap v4,
USDC Earn in/out, Automate grant + unattended run + revoke.

## AUSD Earn (2026-10-12)
EverpieceEarn (AUSD) `0x4bb7d4ce29f7c8410576cdf084637c790fd44e5a`, tx `0x1d3f307d…33e6e7`, block 112,736,995 (finalized), deployer `0xB065b91A2aEDe8A51eF9D453e37Fe67164DB781d` (key on the VPS, root-only).
Vaults allow-listed (read back): Aave waMonAUSD `0x9e1AcC5B…fE76`, Morpho Grove x Steakhouse AUSD `0x32841A85…476D`; AUSD = `0x0000…012a`.
Not done: relayer `EARN_ADDRESS`, web rebuild, canary (needs a GO).
