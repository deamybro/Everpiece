import { config } from "./config";

export type ApiResponse = { status: number; body: Record<string, any> };

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

async function post(base: string, path: string, body: unknown): Promise<ApiResponse> {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: json(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
}

export const relayer = (path: string, body: unknown) => post(config.relayerUrl, path, body);
export const claims = (path: string, body: unknown) => post(config.claimsUrl, path, body);
/**
 * The directory limits requests per IP per minute, and Home polls it. A 429 is refused before anything is done, so it's
 * safe to retry: twice, 1.5 s then 3 s later, before the caller sees it.
 */
export async function directory(path: string, body: unknown): Promise<ApiResponse> {
  for (let attempt = 0; ; attempt++) {
    const r = await post(config.directoryUrl, path, body);
    if (r.status !== 429 || attempt === 2) return r;
    await new Promise((res) => setTimeout(res, 1500 * 2 ** attempt));
  }
}

export type RelayStatus = "SUBMITTED" | "PROCESSING" | "CONFIRMED" | "FAILED" | "REJECTED";

/**
 * Inclusion is not success (ESCROW_SPEC §17): keep polling until the relayer reports CONFIRMED (receipt ok,
 * expected event, state at "finalized") or FAILED.
 */
export async function waitForRequest(requestId: string, onStatus: (s: RelayStatus) => void, timeoutMs = 120_000): Promise<Record<string, any>> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = await fetch(`${config.relayerUrl}/v1/requests/${requestId}`);
    const body = (await r.json()) as Record<string, any>;
    onStatus(body.status);
    if (body.status === "CONFIRMED" || body.status === "FAILED" || body.status === "REJECTED") return body;
    if (Date.now() > until) return { ...body, status: "PROCESSING", timedOut: true };
    await new Promise((res) => setTimeout(res, 800));
  }
}

/** Relayer/claims error codes → consumer copy (master §37: no raw errors to users). */
export function friendlyError(code: string | undefined): string {
  const map: Record<string, string> = {
    InvalidFundingSignature: "Your signature didn't match. Please try again.",
    EmailUnavailable: "Email codes aren't available yet. Send to a phone number or @username instead.",
    EmailDailyLimit: "Too many codes today for this email. Try again later.",
    QUOTE_EXPIRED: "That price has expired. We've fetched a new one — please check it and confirm again.",
    EXCEEDS_EARNINGS: "That's more than you've earned. Earnings only — your deposit stays put.",
    EarnUnavailable: "Earn isn't available right now. Your money stays in your balance.",
    SlippageExceeded: "The vault's price moved before your transaction landed. Nothing changed — please try again.",
    INVALID_AMOUNT: "Enter an amount above $0.",
    UNSUPPORTED_TOKEN: "Everpiece can't use that token for payments yet.",
    UNSUPPORTED_NETWORK: "This request is for a different network than this app.",
    NO_ROUTE: "Converting isn't available right now. Pay from the same currency, or choose to send yours instead.",
    UNSUPPORTED_ASSET: "Everpiece can't settle in that currency.",
    UNSUPPORTED_ROUTE: "There's no way to pay this from that currency right now.",
    CONVERSION_DISABLED: "Converting between USDC and AUSD is switched off right now. Pay in the same currency.",
    USDC_PAYMENTS_DISABLED: "USDC payments are switched off right now.",
    AUSD_PAYMENTS_DISABLED: "AUSD payments are switched off right now.",
    SLIPPAGE_ABOVE_LIMIT: "The conversion price moved too far. Nothing was sent — please try again.",
    FALLBACK_EXCEEDS_MAX: "That payment couldn't be prepared. Please try again.",
    DIRECT_AMOUNT_MISMATCH: "That payment couldn't be prepared. Please try again.",
    WRONG_ROUTE_ENDPOINT: "That payment couldn't be prepared. Please try again.",
    RECEIPT_UNAVAILABLE: "The payment went through, but we couldn't read its receipt yet. Check Activity in a moment.",
    ConversionUnavailable: "Converting isn't available right now. Nothing was sent.",
    CONFIDENTIAL_UNAVAILABLE: "Confidential routing isn't available right now. Pay normally instead.",
    PRIVATE_UNAVAILABLE: "Private payments aren't switched on here.",
    PRIVATE_NOT_COMPLIANT: "The private network's compliance check didn't pass for this account.",
    PRIVATE_LIMIT_1_USDC: "Private payments are limited to $1.00 per action for now.",
    PRIVATE_EPOCH_LIMIT: "The private network's limit for this period is reached. Try again later.",
    PRIVATE_OTHER_GROUP: "This account is registered in a different private group.",
    PRIVATE_STILL_PROCESSING: "The private network is still processing. Check your private balance before trying again.",
    PRIVATE_NEEDS_MON: "Your account needs a little MON for network fees to use private payments.",
    PRIVATE_RECEIVER_NOT_JOINED: "They haven't joined private payments yet.",
    INSUFFICIENT_BALANCE: "You don't have enough for this payment.",
    PROVIDER_UNAVAILABLE: "Payments in other tokens are unavailable right now. Pay with Dollars instead.",
    AGORA_NOT_WHITELISTED: "Conversion is temporarily unavailable. Pay with Dollars instead.",
    POLICY_DENIED: "This payment can't be sent. Nothing was charged.",
    POLICY_REVIEW: "This payment needs a manual check before it can be sent. Nothing was charged.",
    TRANSACTION_REVERTED: "The payment didn't go through. Nothing was charged.",
    NETWORK_UNAVAILABLE: "You seem to be offline. Nothing was charged. Please try again.",
    REQUEST_EXPIRED: "This payment request has expired. Ask them for a new one.",
    REQUEST_ALREADY_PAID: "This payment request has already been paid.",
    REQUEST_TAMPERED: "This payment request couldn't be verified, so it isn't shown. Don't pay it.",
    UNKNOWN_REQUEST: "We couldn't find this payment request. Check the link or QR code.",
    UNKNOWN_VERSION: "This payment request is from a newer version of Everpiece. Please update the app.",
    InvalidPayerSignature: "Your signature didn't match. Please try again.",
    InstantPaymentsUnavailable: "Instant payments are unavailable right now. Use a protected payment instead.",
    FUNDING_UNAVAILABLE: "Adding money from another chain is unavailable right now.",
    BAD_QUOTE: "We couldn't get a price we can trust. Nothing was sent. Please try again.",
    QUOTE_REFUSED: "Aurora couldn't price this. Try a different amount or chain.",
    AMOUNT_TOO_LARGE: "That's more than one top-up can be. Try a smaller amount.",
    UNKNOWN_DEPOSIT: "We can't find this top-up any more. If you sent money, it will be refunded to your wallet.",
    DEPOSIT_REFUSED: "That transaction couldn't be matched to this top-up. It will still be picked up if it was sent correctly.",
    INVALID_ACCOUNT_NUMBER: "A Nigerian account number has exactly 10 digits.",
    UNKNOWN_BANK: "Choose your bank from the list.",
    ACCOUNT_NOT_FOUND: "The bank couldn't find that account. Check the number and the bank.",
    ACCOUNT_NAME_UNAVAILABLE: "This bank can't confirm account names right now, so we can't save it yet. Try another account or later.",
    TooManyVerifications: "Too many account checks today from this network. Try again tomorrow.",
    PREPARE_EXPIRED: "That check took too long. Check the account again.",
    RECORD_MISMATCH: "Something changed while saving. Check the account again.",
    NO_PAYOUT_ACCOUNT: "This person hasn't added a bank account.",
    ACCOUNT_CHANGED: "The recipient changed their bank account. Ask them for a new request.",
    UNSUPPORTED_CURRENCY: "That currency isn't supported yet.",
    NO_RATE: "We couldn't get a naira rate right now. Please try again.",
    PROVIDER_REFUSED: "The payout provider couldn't accept this right now. Nothing was charged.",
    BAD_ORDER: "The payout provider sent something we couldn't verify. Nothing was charged.",
    UNKNOWN_ORDER: "We can't find this payout.",
    DESTINATION_MISMATCH: "We couldn't confirm the recipient's bank details, so nothing was sent.",
    PRICE_CHANGED: "The price changed since you saw it. Nothing was paid. Check the new price and try again.",
    NoUsername: "Pick your @username first, so people can see who they're paying.",
    BelowMinimumPayment: "The minimum payment is $1.00.",
    RecipientCantGetMessages: "This person can't receive messages yet. Remove the message to send the money.",
    MessageUploadFailed: "We couldn't attach your message, so nothing was sent. Try again, or remove the message to send without it.",
    MessageTooLarge: "Your message is too long. Record a shorter voice note or shorten the note.",
    MessageMalformed: "Your message couldn't be prepared. Record it again, or send without it.",
    AmountAboveCap: "That's above the current limit per payment.",
    LiabilityCapExceeded: "Everpiece is at its safety limit right now. Please try a smaller amount later.",
    ERC20InsufficientBalance: "You don't have enough Dollars for this payment.",
    PaymentNotActive: "This payment was already claimed, cancelled or returned.",
    PaymentExpired: "This payment has expired. The money went back to the sender.",
    RecipientMismatch: "This payment isn't for this account.",
    Cooldown: "Please wait a moment before requesting another code.",
    PhoneDailyLimit: "Too many codes today for this phone. Try again later.",
    InvalidCode: "That code isn't right. Check the text message and try again.",
    TooManyAttempts: "Too many wrong codes. Request a new code in a moment.",
    VerificationExpired: "That code expired. Request a new one.",
    InviteNotRegistered: "This payment isn't ready to claim yet.",
    RateLimited: "Too many requests. Please wait a moment.",
    RelayerUnavailable: "Everpiece is busy. Please try again shortly.",
    UpstreamUnavailable: "The network is busy. Please try again shortly.",
    CannotPaySelf: "That's your own username.",
    UnknownUsername: "No one on Everpiece has that username. Check the spelling with them.",
    UsernameTaken: "That username is taken. Try another one.",
    UsernameTooSimilar: "That's too close to someone else's username. Try a different one.",
    UsernameReserved: "That username isn't available. Try another one.",
    InvalidUsername: "Usernames are 3–20 lowercase letters, numbers or _, starting with a letter.",
    InvalidDisplayName: "Please enter a shorter name without special characters.",
    AccountHasUsername: "Your account already has a username.",
    TooManyRegistrations: "Too many new usernames from this network today. Try again tomorrow.",
    RecipientChanged: "This recipient's security details changed. Verify them before sending.",
    RecipientUnverified: "We couldn't verify this username. Please don't send to it.",
    DirectoryUnavailable: "We couldn't look up that username right now. Please try again shortly.",
    VerificationUnavailable: "We couldn't send the code right now. Please try again shortly.",
  };
  return (code && map[code]) || "Something went wrong. Your money is still safe. Please try again.";
}
