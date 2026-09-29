// One real SMS delivery test via Twilio Programmable Messaging (VERIFIED §4.6). SENDS A REAL TEXT and uses one
// Twilio unit — run only with the owner's OK. Prints delivery status only; never prints the code or credentials.
//
//   node --env-file=../../.env scripts/live-sms-test.ts --to +2348000000000
//
// Needs in .env: TWILIO_ACCOUNT_SID, TWILIO_API_USER, TWILIO_API_SECRET, TWILIO_FROM_NUMBER.
import { randomInt } from "node:crypto";
import { otpMessage } from "../src/providers.ts";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const need = (name: string) => {
  const v = process.env[name];
  if (!v) {
    console.error(`missing ${name} in .env`);
    process.exit(2);
  }
  return v;
};

const to = arg("--to");
if (!to || !/^\+[1-9][0-9]{7,14}$/.test(to)) {
  console.error("usage: --to +<country code><number>  (E.164)");
  process.exit(2);
}
const accountSid = need("TWILIO_ACCOUNT_SID");
const from = need("TWILIO_FROM_NUMBER");
const auth = "Basic " + Buffer.from(`${need("TWILIO_API_USER")}:${need("TWILIO_API_SECRET")}`).toString("base64");
const base = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}`;
const masked = to.slice(0, Math.max(2, to.length - 10)) + " ••• ••• " + to.slice(-4);

const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
const res = await fetch(`${base}/Messages.json`, {
  method: "POST",
  headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ To: to, From: from, Body: otpMessage(code) }).toString(),
});
const created = (await res.json()) as { sid?: string; status?: string; code?: number; message?: string };
if (!res.ok) {
  console.log(`send refused: HTTP ${res.status}, Twilio error ${created.code ?? "?"}: ${created.message ?? ""}`);
  process.exitCode = 1;
} else {
  await track(created.sid!, created.status);
}
async function track(sid: string, initial?: string) {
console.log(`sent to ${masked} from ${from}: message ${sid}, initial status ${initial}`);
// Poll delivery status for up to ~90 s (Fetch a Message).
let last = initial;
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const m = (await (await fetch(`${base}/Messages/${sid}.json`, { headers: { authorization: auth } })).json()) as {
    status?: string;
    error_code?: number | null;
    error_message?: string | null;
  };
  if (m.status !== last) console.log(`status: ${m.status}${m.error_code ? ` (error ${m.error_code}: ${m.error_message ?? ""})` : ""}`);
  last = m.status;
  if (["delivered", "undelivered", "failed", "canceled"].includes(m.status ?? "")) break;
}
console.log(`final status: ${last}. Did the text arrive on the phone, reading "Your Everpiece code is ••••••. …"?`);
}
