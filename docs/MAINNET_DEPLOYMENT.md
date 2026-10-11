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
