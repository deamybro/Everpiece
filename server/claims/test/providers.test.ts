// Offline: provider adapters (mocked HTTP), phone vault, config guards. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PhoneVault, SimulatedProvider, TermiiProvider, TwilioVerifyProvider, loadConfig, maskPhone } from "../src/index.ts";

type Call = { url: string; init: RequestInit };
function mockFetch(responses: { status: number; json?: unknown }[]) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift() ?? { status: 500 };
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const twilioCfg = { user: "ACxxxxxxxx", secret: "tok", serviceSid: "VAyyyy", baseUrl: "https://verify.twilio.com/v2" };

test("Twilio Verify: exact endpoints, Basic auth, form encoding, status mapping", async () => {
  const { f, calls } = mockFetch([
    { status: 201, json: { sid: "VE123", status: "pending" } },
    { status: 200, json: { status: "pending" } },
    { status: 200, json: { status: "approved" } },
    { status: 404, json: { code: 20404 } },
    { status: 200, json: { status: "max_attempts_reached" } },
  ]);
  const p = new TwilioVerifyProvider(twilioCfg, f);
  assert.deepEqual(await p.start("+447700900123"), { ref: "VE123" });
  assert.equal(calls[0].url, "https://verify.twilio.com/v2/Services/VAyyyy/Verifications");
  assert.equal(calls[0].init.method, "POST");
  const h = calls[0].init.headers as Record<string, string>;
  assert.equal(h.authorization, "Basic " + Buffer.from("ACxxxxxxxx:tok").toString("base64"));
  assert.equal(h["content-type"], "application/x-www-form-urlencoded");
  assert.equal(calls[0].init.body, "To=%2B447700900123&Channel=sms");

  assert.equal(await p.check("+447700900123", "000000", "VE123"), "wrong");
  assert.equal(calls[1].url, "https://verify.twilio.com/v2/Services/VAyyyy/VerificationCheck");
  assert.equal(calls[1].init.body, "To=%2B447700900123&Code=000000");
  assert.equal(await p.check("+447700900123", "123456", "VE123"), "approved");
  assert.equal(await p.check("+447700900123", "123456", "VE123"), "dead"); // 404: deleted/expired/max attempts
  assert.equal(await p.check("+447700900123", "123456", "VE123"), "dead");
});

test("Twilio Verify: start failures throw (no silent success)", async () => {
  const { f } = mockFetch([{ status: 429, json: {} }, { status: 201, json: { sid: "VE1", status: "failed" } }]);
  const p = new TwilioVerifyProvider(twilioCfg, f);
  await assert.rejects(p.start("+447700900123"));
  await assert.rejects(p.start("+447700900123"));
});

test("Termii: documented fields; verified 'True' → approved; otherwise not approved", async () => {
  const { f, calls } = mockFetch([
    { status: 200, json: { pinId: "pin-1", to: "2348000000000", smsStatus: "Message Sent" } },
    { status: 200, json: { pinId: "pin-1", verified: "True", msisdn: "2348000000000" } },
    { status: 200, json: { pinId: "pin-1", verified: false } },
    { status: 200, json: { verified: "Expired" } },
  ]);
  const p = new TermiiProvider({ baseUrl: "https://acct.api.termii.com/", apiKey: "k", senderId: "Everpiece" }, f);
  assert.deepEqual(await p.start("+2348000000000"), { ref: "pin-1" });
  assert.equal(calls[0].url, "https://acct.api.termii.com/api/sms/otp/send");
  const sent = JSON.parse(String(calls[0].init.body));
  for (const k of ["api_key", "message_type", "to", "from", "channel", "pin_attempts", "pin_time_to_live", "pin_length", "pin_placeholder", "message_text", "pin_type"]) {
    assert.ok(k in sent, k);
  }
  assert.equal(sent.channel, "dnd");
  assert.ok(sent.message_text.includes(sent.pin_placeholder));
  assert.equal(await p.check("+2348000000000", "123456", "pin-1"), "approved");
  assert.equal(calls[1].url, "https://acct.api.termii.com/api/sms/otp/verify");
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { api_key: "k", pin_id: "pin-1", pin: "123456" });
  assert.equal(await p.check("+2348000000000", "000000", "pin-1"), "wrong");
  assert.equal(await p.check("+2348000000000", "000000", "pin-1"), "dead");
});

test("Simulated provider: codes only via sink, single use, expiry", async () => {
  let t = 0;
  const got: string[] = [];
  const p = new SimulatedProvider((_ph, code) => got.push(code), () => t);
  const { ref } = await p.start("+2348000000000");
  assert.match(got[0], /^[0-9]{6}$/);
  assert.equal(p.live, false);
  assert.equal(await p.check("", "999999" === got[0] ? "999998" : "999999", ref), "wrong");
  assert.equal(await p.check("", got[0], ref), "approved");
  assert.equal(await p.check("", got[0], ref), "dead"); // single use
  const second = await p.start("+2348000000000");
  t += 600_001;
  assert.equal(await p.check("", got[1], second.ref), "dead"); // expired
});

test("PhoneVault: AES-GCM round trip, random IV, tamper detection, keyed lookup, masking", () => {
  const v = new PhoneVault(("0x" + "42".repeat(32)) as `0x${string}`);
  const a = v.encrypt("+2348000000000");
  const b = v.encrypt("+2348000000000");
  assert.notEqual(a, b);
  assert.ok(!a.includes("2348000000000"));
  assert.equal(v.decrypt(a), "+2348000000000");
  const [iv, tag, ct] = a.split(".");
  const flipped = Buffer.from(ct, "base64url");
  flipped[0] ^= 1;
  assert.throws(() => v.decrypt([iv, tag, flipped.toString("base64url")].join(".")));
  assert.equal(v.lookupKey("+2348000000000"), v.lookupKey("+2348000000000"));
  assert.notEqual(v.lookupKey("+2348000000000"), new PhoneVault(("0x" + "43".repeat(32)) as `0x${string}`).lookupKey("+2348000000000"));
  assert.equal(maskPhone("+2348000000000"), "+234 ••• ••• 0000");
  assert.equal(maskPhone("+447700900123"), "+44 ••• ••• 0123");
});

test("config: simulated SMS refused unless explicitly allowed AND local RPC; providers need credentials", () => {
  const base = {
    MONAD_RPC: "https://rpc.monad.xyz",
    ESCROW_ADDRESS: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
    APPROVER_PRIVATE_KEY: "0x" + "11".repeat(32),
    PHONE_ENC_KEY: "0x" + "22".repeat(32),
  };
  assert.throws(() => loadConfig({ ...base, SMS_PROVIDER: "simulated" }), /simulated/);
  assert.throws(() => loadConfig({ ...base, SMS_PROVIDER: "simulated", ALLOW_SIMULATED_SMS: "1" }), /localhost/);
  assert.equal(loadConfig({ ...base, SMS_PROVIDER: "simulated", ALLOW_SIMULATED_SMS: "1", MONAD_RPC: "http://127.0.0.1:8545" }).smsProvider, "simulated");
  assert.throws(() => loadConfig({ ...base }), /TWILIO_API_USER/);
  assert.throws(() => loadConfig({ ...base, SMS_PROVIDER: "termii" }), /TERMII_BASE_URL/);
  assert.throws(() => loadConfig({ ...base, SMS_PROVIDER: "twilio", TWILIO_API_USER: "a", TWILIO_API_SECRET: "b", TWILIO_VERIFY_SERVICE_SID: "c", PHONE_ENC_KEY: "0x12" }), /PHONE_ENC_KEY/);
  const ok = loadConfig({ ...base, TWILIO_API_USER: "a", TWILIO_API_SECRET: "b", TWILIO_VERIFY_SERVICE_SID: "c" });
  assert.equal(ok.approvalTtlSec, 300);
  assert.deepEqual(ok.resendCooldownsSec, [30, 60, 120, 300, 600]);
});
