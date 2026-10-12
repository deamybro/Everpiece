# Request to Agora: APPROVED_SWAPPER for EverpiecePayV2 (Monad mainnet)

Send to Agora (Discord/support or the Instant Settlement contact on docs.agora.finance). Facts below are on-chain or from `docs/VERIFIED.md` §4.14, §4.19 and `docs/MAINNET_DEPLOYMENT.md`.

---

**Subject:** Everpiece — request to approve a payments contract as APPROVED_SWAPPER on the AUSD/USDC Instant Settlement pair (Monad, chain 143)

Hi Agora team,

We are Everpiece, a mobile payments app on Monad built for the Agora cross-border payments bounty. Users sign in with a Mera passkey and send AUSD or USDC to a username, phone, email or an external wallet. Transfers settle on Monad through a relayer, so the sender needs no gas.

We would like to route USDC to AUSD conversions through your Instant Settlement pair, and we need the contract that calls it to hold `APPROVED_SWAPPER`.

**Contract to approve**
- `EverpiecePayV2` on Monad mainnet: `0x29D15Bb918589B9dF84EdE5c3B5A7a3Ec89c8eb5`
- Pair: AUSD/USDC `0xf33286E3222D1c829dACeac48c0Ec651F6452470` (factory `0x8468587Af422ad440F58a57E955eCA6A970b5375`)
- Deployed 2026-10-11 by our deployer; escrow owner (pause and caps, never moves funds) `0x803376Fb273cBC5B5dceb74741f47EF595699d8E`.

**How the contract uses the pair**
- It calls the pair only when a payer signed a payment of an exact amount of AUSD, funded from USDC, with a signed maximum amount of USDC to spend. Nothing moves without that signature.
- It calls the pair on behalf of the payer in the same transaction. It holds no balances between payments.
- If the pair reverts or the contract is not approved, the payment either delivers USDC instead (only if the payer signed that fallback) or fails with nothing moved. We never report AUSD as delivered when it was not.
- Until you approve us, conversions use a fixed, permissionless Uniswap v4 AUSD/USDC pool. We would rather use your pair for AUSD liquidity.

**What we have tested**
- Real-money canaries on mainnet for USDC and AUSD payments and the permissionless conversion path.
- Fork tests of USDC to AUSD through your pair with `EverpiecePayV2` impersonating an approved swapper (gas about 520k worst case).

**What we are asking**
1. Is there an application or KYB step for `APPROVED_SWAPPER`, and who handles it?
2. Once approved, we will run a $1 canary through your pair and report the result.

Contact: ezennemma@gmail.com

Thank you,
Everpiece
