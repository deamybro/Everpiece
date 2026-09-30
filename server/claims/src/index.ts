export { loadConfig, isLocalRpc, type ClaimsConfig, type SmsProviderName, type EmailProviderName } from "./config.ts";
export { ClaimsService, type Result } from "./claims.ts";
export { LocalOtp, SimulatedProvider, SimulatedEmailProvider, emailProviderFromConfig, otpEmail, TermiiProvider, TwilioSmsProvider, TwilioVerifyProvider, ProviderError, otpKeyFrom, otpMessage, providerFromConfig, type VerificationProvider, type CheckResult } from "./providers.ts";
export { PhoneVault, maskPhone, maskEmail, emailLookupInput } from "./phone.ts";
export { ClaimsStore, type Channel } from "./store.ts";
export { createClaimsServer } from "./server.ts";
export { setLogSink } from "./log.ts";
