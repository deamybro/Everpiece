// Feature flags (src/flags.ts): fail closed; NGN payout can't be switched on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FEATURE_FLAGS, readFlags } from "../src/index.ts";

test("everything is off by default", () => {
  const f = readFlags({});
  for (const k of FEATURE_FLAGS) assert.equal(f[k], false);
});

test("only the exact string 'true' turns a flag on; prefix supported", () => {
  assert.equal(readFlags({ USDC_PAYMENTS_ENABLED: "true" }).USDC_PAYMENTS_ENABLED, true);
  for (const v of ["1", "TRUE", "yes", " true"]) assert.equal(readFlags({ EARN_ENABLED: v }).EARN_ENABLED, false);
  assert.equal(readFlags({ NEXT_PUBLIC_EARN_ENABLED: "true" }, "NEXT_PUBLIC_").EARN_ENABLED, true);
});

test("NGN payout stays off (Coming Soon); the DEX fallback is a normal flag", () => {
  const f = readFlags({ NGN_PAYOUT_ENABLED: "true", DEX_AUSD_FALLBACK_ENABLED: "true" });
  assert.equal(f.NGN_PAYOUT_ENABLED, false);
  assert.equal(f.DEX_AUSD_FALLBACK_ENABLED, true);
});
