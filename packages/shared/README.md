# @everpiece/shared

The single source of the EverpieceEscrow interface for web, relayer, approver server and indexer (master §45).
Do not re-declare these ABIs, types or hashes anywhere else.

| Export | What |
|---|---|
| `everpieceEscrowAbi`, `ausdAbi` | Generated from `contracts/out` by `scripts/gen-shared-abi.mjs` |
| `escrowTypes`, `ausdTypes`, `escrowDomain`, `ausdDomain` | EIP-712 definitions (ESCROW_SPEC §6) |
| `paymentIdOf`, `fundingAuthorization` | The paymentId and the one AUSD `ReceiveWithAuthorization` the sender signs (§7) |
| `claimIntent`, `linkClaimIntent`, `claimApproval`, `cancelIntent` | Typed data for each action |
| `recipientCommitment`, `metadataCommitment` | Commitments (§3) |
| `deriveEverpieceAccountV1` | Frozen Mera recipe `EVERPIECE_ACCOUNT_V1` (§18.6); handles secrets, read its doc comment |
| constants | chain 143, AUSD address/decimals/domain ("Agora Dollar"!), V1 ceilings, expiry bounds |
| `vectors.json` | Canonical test vectors; every implementation must reproduce them |

```bash
npm ci && npm test && npm run typecheck
```

`npm test` re-derives every vector with viem (a 4th implementation next to cast, Solidity and the live contract) and checks that viem's `signTypedData` output is byte-identical to the published signatures.

Regenerate the ABI after any contract change: `(cd contracts && forge build) && node scripts/gen-shared-abi.mjs`.
