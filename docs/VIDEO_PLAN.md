# Video plan: pitch, technical demo, and the four bounty clips

Rule for every line: **clear beats clever.** Short words, one idea per sentence. Say only what the app really does today. I cannot record or edit video; this is the script, the shot list, and what to capture. Record once, reuse the clips.

Use the numbers the live indexer reports (run `node scripts/envio-demo.mjs`): about 9 payments and $9.50 moved by 5 users. Say "real payments on Monad mainnet, real money, small amounts". Do not invent traction or market figures; where a number is needed, read one from a source you can name on screen, or say it without a number.

---

## A. PITCH VIDEO (2:00 max, talking head plus slides; about 280 words)

**Slide 1: the pain (0:00 to 0:15)**
"Sending money to family in another country is still painful. The fees eat it. It takes days. And the person on the other end needs the same app, a bank account, or a crypto wallet with a seed phrase they will lose."

**Slide 2: who feels it (0:15 to 0:25)**
"Millions of families live on money sent across borders. They are tired of paying fees, waiting, and being told to 'just use crypto'."

**Slide 3: the fix (0:25 to 0:45)**
"Everpiece is dollars that move like a text message. One fingerprint makes your account. You send dollars to a username. It arrives in seconds. No seed phrase. No gas. And the person paying you can be on any chain, with no account at all."
(Show the home screen with USDC and AUSD.)

**Slide 4: why onchain (0:45 to 1:00)**
"It's onchain so it settles in about one second, anyone can check it, and we never hold your money. Your phone signs the exact payment. We cannot change the amount or the person."

**Slide 5: it works (1:00 to 1:20)**
(Screen recording, 15 seconds, fast: send, receipt, balance up.) "This is live on Monad mainnet with real money."

**Slide 6: what's different (1:20 to 1:35)**
"Other apps need you to understand wallets. We hide all of it. You can be paid from Base, Ethereum or BNB Chain by someone with no Everpiece account. Your messages are private, locked with your own passkey."

**Slide 7: who pays us and who uses it first (1:35 to 1:50)**
"We earn a small fee on each payment and a share on cross-chain payments. First users are people who already send money home: freelancers paid from abroad, and families. They tell the next person, because the sender needs nobody else to join."

**Slide 8: team and ask (1:50 to 2:00)**
"I'm **[your name]**. **[One line: what you have built or done before]**. Everpiece is live today. Next: bank payout in Nigeria and more chains. Dollars, across borders, with one fingerprint."

Daily use (say it in slide 7 if there is time, or put it as on-screen text): money in your balance can earn in a vault; rules move money for you; requests and pay links bring people back.

**Sustainability (on-screen text under slide 7):** relayer fee per payment, conversion spread, cross-chain integrator share. Gas on Monad is a fraction of a cent, so a small fee works.

---

## B. TECHNICAL DEMO VIDEO (3:00 max, product only, no slides)

1. **0:00 Onboarding (0:20).** New phone profile, "Create account", fingerprint, pick a username. Say: "One fingerprint. No seed phrase, no extension, no email."
2. **0:20 Balances (0:10).** Home shows USDC and AUSD. Say: "Two dollars, side by side."
3. **0:30 Gasless send with the unlock session (0:40).** Tap "Unlock for 5 min" (fingerprint). Send $0.25 AUSD to the second account's username. Show "Paid" and the receipt. Say: "The sender paid no gas. After one fingerprint, small payments don't ask again, within a cap, for five minutes."
4. **1:10 Receiver (0:15).** Second phone: balance up by $0.25.
5. **1:25 Across borders (0:55).** Desktop. Open the pay link. Pick USDC on Base or BNB Chain, $1, refund address, deposit address appears, send from a crypto wallet. Speed this part up and say so on screen: "takes a few minutes". Show "Paid" and the Monad transaction.
6. **2:20 Earn (0:20).** Earn page: Aave and Morpho vaults, the live Morpho rate. Say: "Dollars can earn while they wait. Withdraw any time, no gas."
7. **2:40 Close (0:20).** Profile: Encrypted backup. Say: "Contacts and messages are encrypted with your passkey. A new phone gets them back."

---

## C. BOUNTY CLIPS (each 2:00 max, built from the same raw clips)

### Agora (Best Cross-Border Payments App)
- 0:00 Onboarding clip (15 s). 0:15 Home with AUSD balance (10 s). 0:25 Unlock plus send AUSD to a username (30 s). 0:55 Receiver balance (10 s). 1:05 Pay link from Base or BNB (35 s, speed up). 1:40 Code on screen for 10 s: `contracts/src/EverpiecePayV2.sol`, the part that tries Agora's pair then the fixed Uniswap v4 route. Say: "The Agora route switches on when Agora approves our contract; today the live conversion uses Uniswap." 1:50 Close: "AUSD, across borders, with one fingerprint."

### Mera: Best Mera-Powered UX
- 0:00 Create account, one fingerprint, stopwatch visible (20 s). 0:20 Unlock session bar with timer and cap (15 s). 0:35 Two payments with no new prompt (25 s). 1:00 A different action (a rule or private payment) that DOES ask: "Only payments with an amount skip the prompt" (15 s). 1:15 **Stateless test:** clear site data, reload, sign in with the passkey, username and balance return (35 s). 1:50 Close.

### Mera: One Passkey, Many Keys
- 0:00 Say: "One passkey. Several keys. None stored." (10 s). 0:10 Send a payment with a voice note or text to the second account (25 s). 0:35 On a **second device or fresh browser profile**, sign in with the same passkey and open the message: it decrypts (30 s). 1:05 Profile, "Back up now" (two fingerprints) (20 s). 1:25 On the second device, "Restore here": contacts and receipts appear (30 s). 1:55 Close: "The server only ever holds scrambled data."

### Envio
- 0:00 "Everpiece uses Envio to index our contracts on Monad." (10 s). 0:10 Terminal: run `node scripts/envio-demo.mjs`. It prints the indexer's block next to the chain head (3 behind), the latest payments with transaction hashes, the latest Earn events, and the totals (25 s, leave it on screen for 10 s). 0:45 Open the app **Activity** page: "this list comes from the same index" (20 s). 1:05 Open "Everpiece in numbers": the totals page (15 s). 1:20 Say: "A rule engine reads this index to trigger rules when a payment arrives. It never decides money: balances are re-read onchain at the finalized block." (20 s). 1:40 Close.

---

## D. WHAT TO CAPTURE (record each once, in this order, then cut)

**Phone (screen record with audio off; add voice later):**
1. Create a brand-new account (fresh browser profile). Keep the clock visible.
2. Home balances (USDC and AUSD).
3. Unlock for 5 min, then two small AUSD sends to a username, with the receipts.
4. A message or voice note attached to a payment.
5. Earn page with the vault tabs and the Morpho rate.
6. Profile: Back up now.
7. Clear site data, reload, sign in.

**Second phone or second browser profile:**
8. Receiver's balance and activity after step 3.
9. Sign in with the same passkey, open the message, then "Restore here".

**Computer:**
10. The pay link opened, USDC on Base or BNB chosen, deposit address shown, the crypto wallet sending, then "Paid". Start this one first: it takes about 3 minutes.
11. `node scripts/envio-demo.mjs` in a terminal, plus the Activity and "in numbers" pages.
12. The Monad transaction page for one payment.
13. Code on screen: `EverpiecePayV2.sol` (the Agora then Uniswap order).

**Voice:** record the narration separately in a quiet room (phone voice recorder), reading the lines above. Then put voice over the clips in any simple editor (CapCut works).

## E. Order of work, with about 3 hours left
1. Deploy the merged app if you have not (the steps I sent), and confirm Home and Earn look right (10 min).
2. Record all clips in D (40 min). Start item 10 first.
3. Record the narration (20 min).
4. Edit the 5 videos: pitch, technical demo, Agora, Mera x2, Envio (45 min). They share most clips.
5. Upload, paste links, Save, Submit (20 min). Leave 30 minutes of buffer.
If you run short: record the pitch, the technical demo, and Agora first. Use the technical demo link for the Mera UX and Many Keys fields if you have to.
