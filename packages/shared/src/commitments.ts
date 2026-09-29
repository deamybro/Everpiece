import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { TAG_METADATA_V1, TAG_RECIPIENT_V1, type PaymentMode } from "./constants.ts";

/**
 * recipientCommitment = keccak256(abi.encode(TAG_RECIPIENT_V1, uint8 mode, address account, bytes32 recipientSalt))
 * USERNAME: account = recipient's Mera account. LINK: account = link claim-key address. (ESCROW_SPEC §3.1)
 * recipientSalt: 32 random bytes (crypto.getRandomValues) — hides the recipient until claim; not a security secret.
 */
export function recipientCommitment(mode: PaymentMode, account: Address, recipientSalt: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint8" }, { type: "address" }, { type: "bytes32" }],
      [TAG_RECIPIENT_V1, mode, account, recipientSalt],
    ),
  );
}

/**
 * metadataCommitment = keccak256(abi.encode(TAG_METADATA_V1, bytes32 envelopeHash, bytes32 metadataSalt)),
 * or bytes32(0) when there is no message/voice. envelopeHash = keccak256(canonical ciphertext envelope bytes).
 * Never commit plaintext, usernames, phone numbers, emails, URLs or keys (ESCROW_SPEC §3.2).
 */
export function metadataCommitment(envelopeHash: Hex, metadataSalt: Hex): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }], [TAG_METADATA_V1, envelopeHash, metadataSalt]),
  );
}

export const NO_METADATA: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";
