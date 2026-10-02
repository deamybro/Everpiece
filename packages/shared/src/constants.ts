import { keccak256, stringToHex } from "viem";

/** Monad mainnet (docs/VERIFIED.md §1.1). */
export const MONAD_MAINNET_CHAIN_ID = 143;

/** AUSD proxy on Monad mainnet (docs/VERIFIED.md §2.1). Base units: 6 decimals. */
export const AUSD_ADDRESS = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a" as const;
export const AUSD_DECIMALS = 6;
/** NOTE: the AUSD EIP-712 domain name is "Agora Dollar", NOT `name()` ("AUSD") — VERIFIED §2.4. */
export const AUSD_EIP712_NAME = "Agora Dollar";
export const AUSD_EIP712_VERSION = "1";

/** Monad testnet (docs/VERIFIED.md §4.9). AUSD does not exist there; Everpiece uses TestDollar instead. */
export const MONAD_TESTNET_CHAIN_ID = 10143;
/** TestDollar (contracts/src/testnet): testnet-only AUSD stand-in, honestly named. Same EIP-712 version as AUSD. */
export const TEST_DOLLAR_EIP712_NAME = "Everpiece Test Dollar";

/** The dollar token a deployment uses: real AUSD on mainnet, TestDollar on testnet. */
export type DollarToken = { address: `0x${string}`; eip712Name: string; eip712Version: string };
export const AUSD_TOKEN: DollarToken = { address: AUSD_ADDRESS, eip712Name: AUSD_EIP712_NAME, eip712Version: AUSD_EIP712_VERSION };

export const ESCROW_EIP712_NAME = "Everpiece Escrow";
export const ESCROW_EIP712_VERSION = "1";

export const PaymentMode = { USERNAME: 1, LINK: 2 } as const;
export type PaymentMode = (typeof PaymentMode)[keyof typeof PaymentMode];

/** On-chain Status enum. EXPIRED is derived: ACTIVE && now >= expiresAt. */
export const PaymentStatus = { NONE: 0, ACTIVE: 1, CLAIMED: 2, CANCELLED: 3, REFUNDED: 4 } as const;

/** V1 ceilings (D3). Values in AUSD base units / seconds, as bigint. */
export const MAX_PAYMENT_CEILING = 500_000_000n; // $500
export const MAX_LIABILITY_CEILING = 5_000_000_000n; // $5,000
export const MIN_EXPIRY_SECONDS = 86_400n; // 1 day
export const MAX_EXPIRY_SECONDS = 2_592_000n; // 30 days
export const DEFAULT_EXPIRY_SECONDS = MAX_EXPIRY_SECONDS; // UX default 30 days

export const TAG_RECIPIENT_V1 = keccak256(stringToHex("everpiece.recipient.v1"));
export const TAG_METADATA_V1 = keccak256(stringToHex("everpiece.metadata.v1"));

/** Frozen passkey account recipe (ESCROW_SPEC §18.6). Changing any field changes every user's address. */
export const EVERPIECE_ACCOUNT_V1 = {
  id: "EVERPIECE_ACCOUNT_V1",
  source: "Mera 'Create passkey accounts' recipe @ category-labs/mera v0.2.0",
  mnemonic: "BIP-39 english, 24 words from 32-byte PRF output, no passphrase",
  path: "m/44'/60'/0'/0/0",
} as const;
