# PAYOUT.md — the last mile: Dollars → a Nigerian bank account

**Owner (2026-10-06):** "Everpiece should solve" the last mile. Stablecoins only matter if the recipient can actually spend local currency.

**V1, deliberately narrow:** stablecoin/AUSD → **NGN → a Nigerian bank account**. Not mobile money yet, not other countries, not several providers.

Facts: `docs/VERIFIED.md` §4.15 (Paycrest, CCTP V2) and §4.14 (USDC, Agora). Routing context: `docs/ROUTING.md`.

## 1. What the user sees

**Recipient: "How do you want to receive money?"**
- ○ Dollars in Everpiece
- ● Nigerian bank account: bank, account number. Everpiece verifies the account name and shows it. The recipient confirms with their passkey (they sign where their money may go).

**Recipient requests "₦50,000".** It's a QR code / link, like any request.

**Sender sees:**

```text
Maris receives at least ₦50,000
to GTBank ••••6789 · verified name: MARIS OKAFOR
You pay        33.42 Dollars
Rate / fees    shown, from the live payout quote
[Pay with fingerprint]
```

**Then:** paying → sent to the bank → **Delivered** (only when the payout provider confirms the bank transfer), or a clear failure → refunding → refunded.

## 2. Flow and custody (owner-confirmed decisions)

```text
recipient's signed payout request (₦ amount + their signed bank destination)
 → Everpiece payout server: verify account, live rate, create the provider order
   (Paycrest: receiveAddress on Base, amountToTransfer, validUntil)
 → sender signs once
 → MAINNET: EverpiecePayout (new contract, one transaction, nobody holds the money):
     sender's AUSD (ERC-3009) → Agora AUSD→USDC (exact output) → CCTP V2 depositForBurn
     (domain 6 = Base, mintRecipient = Paycrest receiveAddress)
   TESTNET: SIMULATED (no Paycrest sandbox exists): exact AUSD to the simulated provider's deposit address
 → provider pays the bank → `payment_order.validated` → DELIVERED
```

| # | Decision (owner, 2026-10-06) | Consequence |
|---|---|---|
| P1 Custody | **Nobody.** One non-custodial contract on mainnet | `EverpiecePayout` (§5) needs to be written, tested, adversarially reviewed and given the owner's GO before mainnet |
| P2 Amount promise | **"At least ₦X"**, quoted with a buffer, until Paycrest confirms the rate is locked at order creation (TODO(VERIFY)) | The UI never says "exactly ₦" for bank payouts yet |
| P3 Refunds | Paycrest refunds USDC to **the sender's own address on Base** (the same key as their Everpiece account). Everpiece shows it and offers a payer-initiated "bring it back to Monad". **Never automatic** | Same rule as ROUTING.md §5 |
| P4 Bank data | **Encrypted at rest on the payout server** (AES-256-GCM, like phone numbers in claims). Senders see the bank + masked number + verified name. The full number goes only to the provider at payout | The payout server holds an encryption key; the THREAT_MODEL gains an entry |

**Signed destination.** The recipient's passkey signs `PayoutAccount {account, institution, accountHash, accountName, currency}`, and every request signs the amount plus that destination's hash. A compromised server can't redirect anyone's money to a different bank account without the recipient's signature. The sender's app verifies both signatures before paying.

## 3. States: never "Delivered" because the blockchain leg succeeded

| Everpiece state | Paycrest status/event | Shown as |
|---|---|---|
| `QUOTED` | (before the order) | price shown |
| `AWAITING_PAYMENT` | `initiated` | "Waiting for payment" |
| `PAYOUT_FUNDED` | `payment_order.deposited` | "Payment received, sending to the bank" |
| `BANK_PROCESSING` | `pending` | "Bank transfer in progress" |
| `DELIVERED` | **`payment_order.validated`** (provider confirms the fiat payout) and later `settled` | "Delivered ✓" |
| `REFUNDING` | `payment_order.refunding` | "The bank transfer failed; refunding" |
| `REFUNDED` | `refunded` | "Refunded to your account on Base" |
| `EXPIRED` | `expired` | "Not paid in time; nothing was taken" |

Webhooks are accepted only with a valid `X-Paycrest-Signature` (HMAC-SHA256 of the raw body, timing-safe compare). Polling `GET /v2/sender/orders/{id}` is the fallback. State only moves forward.

## 4. Failure matrix

| What fails | Where the money is | Everpiece does |
|---|---|---|
| Account verification | Nothing has moved | The recipient fixes their details |
| Quote/order creation | Nothing has moved | Error; nothing to pay |
| The sender doesn't pay before `validUntil` | Nothing moved | `EXPIRED` |
| On-chain leg (mainnet: the conversion or CCTP burn reverts) | The sender's own AUSD, untouched | Relayer simulation refuses first; no gas wasted |
| CCTP mint on Base delayed | In flight; Circle's attestation | Waits; shows "on the way" |
| Bank payout fails | Paycrest refunds USDC to the sender's own address on Base | `REFUNDING` → `REFUNDED`; offers "bring it back" (payer-initiated) |

## 5. `EverpiecePayout` (mainnet, design only, not written yet)

- `payToBank(Payment p, bytes ausdSignature, PayoutLeg leg)` does all of this in one transaction:
  1. AUSD `receiveWithAuthorization` (nonce = payment id; binds the amount and the leg);
  2. Agora `swapTokensForExactTokens` AUSD → exactly `leg.usdcAmount` USDC (an AUSD ceiling signed by the sender; unused AUSD returned);
  3. USDC approve → `TokenMessengerV2.depositForBurn(leg.usdcAmount, 6, bytes32(leg.receiveAddress), USDC, destinationCaller, maxFee, 2000)`;
  4. emits `PaidOut(paymentId, orderRef, …)`.
- No owner or admin; fixed pair, messenger and domain at deploy; each payment settles once.
- The sender signs the leg (receiveAddress, amount, order reference), so the relayer can't change where the money goes.
- **Open before writing it:**
  - CCTP V2 `maxFee` on Monad mainnet (upfront fees are supported on mainnet);
  - who calls `receiveMessage` on Base (the Everpiece relayer on Base needs ETH, or a forwarding service);
  - whether Paycrest accepts a CCTP mint as the deposit (it should; it's a plain USDC transfer to `receiveAddress`), checked with a $0.50 real order.

## 6. Status and next steps

| Piece | State |
|---|---|
| Design, decisions P1–P4 | ✅ this file |
| Provider layer (`PayoutProvider`: Paycrest, Simulated) + payout server + signed bank destinations + web flow | In progress (testnet, SIMULATED) |
| Paycrest live | ❌ 👤 Owner: sign up at app.paycrest.io and complete **KYB** → API Key + API Secret |
| `EverpiecePayout` contract | ❌ design only (§5) |
| First real payout | ❌ 👤 after KYB + contract + GO: one $0.50–$1 order to a real NG account, with the provider's confirmation as evidence |
| Yellow Card (backup, bank + mobile money) | Not verified (VERIFIED §4.15 TODO) |
