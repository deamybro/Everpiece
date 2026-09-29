import { HDKey } from "@scure/bip32";
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { bytesToHex, type Address } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { EVERPIECE_ACCOUNT_V1 } from "./constants.ts";

/**
 * EVERPIECE_ACCOUNT_V1 — Mera's documented recipe, verbatim (VERIFIED §3.4, ESCROW_SPEC §18.6):
 *   prfOutput(32B) → BIP-39 english mnemonic (no passphrase) → seed → BIP-32 m/44'/60'/0'/0/0.
 *
 * SECURITY: `prfOutput` and the returned `privateKey` are the user's funds. Never persist, log, send or cache them.
 * Pass `privateKey` to Mera `createSecp256k1SigningSession`, then `privateKey.fill(0)` and end the session after
 * the single financial action it was derived for (master §22.2, §22.4). JS strings (the mnemonic) cannot be
 * zeroed; this function never returns it.
 */
export function deriveEverpieceAccountV1(prfOutput: Uint8Array): { privateKey: Uint8Array; address: Address } {
  if (prfOutput.length !== 32) throw new Error("EVERPIECE_ACCOUNT_V1: PRF output must be 32 bytes");
  const seed = mnemonicToSeedSync(entropyToMnemonic(prfOutput, wordlist));
  const root = HDKey.fromMasterSeed(seed);
  const node = root.derive(EVERPIECE_ACCOUNT_V1.path);
  seed.fill(0);
  if (!node.privateKey) throw new Error("EVERPIECE_ACCOUNT_V1: derivation produced no key");
  const privateKey = Uint8Array.from(node.privateKey);
  node.wipePrivateData();
  root.wipePrivateData();
  return { privateKey, address: privateKeyToAddress(bytesToHex(privateKey)) };
}
