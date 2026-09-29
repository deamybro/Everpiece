# DEMO_SCRIPT.md — 3-minute demo (DRAFT, master §56)

Every claim in the demo is backed by a real mainnet transaction or an honestly labeled DISABLED/SIMULATED/SANDBOX state. Proof links are filled from real transactions only.

## Part 1 — Human moment (0:00–1:30)

| Beat | Shows | Proof |
|---|---|---|
| Stella: "Send $200 to Mama" | Choose @mama (recipient confirmation on first send) → $200 → note "For October ❤️" → 30-second voice note | — |
| Review | You send $200 · Everpiece fee $0 · Recipient receives $200 · Expiry 30 days · "Free to claim" | — |
| Passkey → Send | "Protecting your payment…", then "Sent" after on-chain confirmation (not on inclusion) | createPayment tx: TODO |
| Mama opens the link | Verifies (SMS code to her phone) → message unwraps → plays Stella's voice note | — |
| Fingerprint → Claim | "You received $200." Real Dollars in Mama's account | claimLinkPayment tx: TODO |
| What next | Keep Dollars. Show Cash out / Own a Piece **only if LIVE**; otherwise omit or label honestly | — |

## Part 2 — Why Everpiece exists (1:30–2:15)

Another payment to the wrong person → before claim → **Cancel** → "Money returned" only after the refund tx succeeds. Show the real Monad tx and the AUSD returned.
Proof: cancel tx TODO; optional expired refund tx TODO (canary C).

## Part 3 — Proof (2:15–3:00)

Deployed contract (Sourcify / Monadscan), tx hashes, and real counts only (users, payments, claim rate, cancellations, refunds, median claim time). If there are 8 users, show 8.

## Backup paths

- Pre-recorded video of each flow on a budget Android phone and an iPhone.
- Pre-created payments in known states (active, claimed, cancelled, refunded) with explorer links.
- WhatsApp WebView fails live → show the "Open securely in your browser" handoff and continue in Chrome.
- Relayer/RPC degraded → show explorer links of earlier real transactions. Never fake a live transaction.

## Proof links (real data only)

- Escrow contract: TODO · Canary A (send→claim), B (send→cancel), C (expire→refund): TODO (`evidence/`)
