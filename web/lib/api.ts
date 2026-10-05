import { config } from "./config";

export type ApiResponse = { status: number; body: Record<string, any> };

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

async function post(base: string, path: string, body: unknown): Promise<ApiResponse> {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: json(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
}

export const relayer = (path: string, body: unknown) => post(config.relayerUrl, path, body);
export const claims = (path: string, body: unknown) => post(config.claimsUrl, path, body);
export const directory = (path: string, body: unknown) => post(config.directoryUrl, path, body);

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
    UNSUPPORTED_TOKEN: "Everpiece can't use that token for payments yet.",
    UNSUPPORTED_NETWORK: "This request is for a different network than this app.",
    NO_ROUTE: "There's no way to convert that token right now. Pay with Dollars instead.",
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
