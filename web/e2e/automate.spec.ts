// Automate on the TESTNET stack (docs/AUTOMATE.md): Stella signs "split my income 50/30/20"; a payer with no username
// sends her $20 instantly; the watcher (indexer at finality) plans the run within her limits; she confirms with one
// fingerprint; $6 goes into Earn (real EverpieceEarn, SIMULATED-yield test vault), $10 stays, and the NVIDIA 20% is
// SKIPPED — no stock route passes the quality rules — so its $4 stays in her balance and the run is PARTIAL, not done.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

async function withPasskeys(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true,
    },
  });
  return page;
}

test.afterEach(async ({ browser }) => {
  for (const c of browser.contexts()) await c.close();
});

test("Automate: signed split rule → payment arrives → one confirmation → Earn gets 30%, the unavailable stock share stays", async ({ browser }) => {
  test.setTimeout(600_000);
  const stella = await withPasskeys(await browser.newContext());
  const payer = await withPasskeys(await browser.newContext());
  const csp: string[] = [];
  for (const p of [stella, payer]) p.on("console", (m) => m.type() === "error" && /Content Security Policy/.test(m.text()) && csp.push(m.text()));
  const S = `stella_${Date.now().toString(36).slice(-5)}`;

  await stella.goto("/");
  await stella.getByLabel("Your first name").fill("Stella");
  await stella.getByRole("button", { name: "Create my account with fingerprint or screen lock" }).click();
  await stella.getByLabel("Username", { exact: true }).fill(S);
  await expect(stella.getByText(`@${S} is available ✓`)).toBeVisible();
  await stella.getByRole("button", { name: `Save @${S} with fingerprint or screen lock` }).click();
  await expect(stella.getByText(`Your username: @${S}`)).toBeVisible();

  // the rule: preview is explicit about what can't run, then Stella signs it
  await stella.getByRole("link", { name: "Automate your money" }).click();
  await stella.getByRole("button", { name: /Split my income/ }).click();
  await stella.getByRole("button", { name: "Preview" }).click();
  const preview = stella.getByLabel("Rule preview");
  await expect(preview).toContainText("When money arrives");
  await expect(preview).toContainText("50% stays in your balance");
  await expect(preview).toContainText("30% goes into Earn");
  await expect(preview).toContainText("20% buys NVIDIA");
  await expect(stella.getByLabel("Unavailable now")).toContainText("NVIDIA: unavailable now");
  await expect(preview).toContainText("You confirm each run with your fingerprint");
  await stella.getByRole("button", { name: "Save rule with fingerprint or screen lock" }).click();
  await expect(stella.getByText("Rule saved ✓", { exact: false })).toBeVisible();
  await expect(stella.getByLabel("Rule Split my income")).toContainText("On");

  // a payer with no username sends $20 to @stella (instant by default)
  await payer.goto("/");
  await payer.getByLabel("Your first name").fill("Payer");
  await payer.getByRole("button", { name: "Create my account with fingerprint or screen lock" }).click();
  await payer.getByRole("button", { name: "Get 100 test Dollars" }).click();
  await expect(payer.locator(".balance")).toHaveText("$100.00");
  await payer.getByRole("link", { name: "Send money" }).click();
  await payer.getByLabel("Amount in Dollars").fill("20");
  await payer.getByRole("button", { name: "Continue" }).click();
  await payer.getByRole("button", { name: "@username" }).click();
  await payer.getByLabel("Their Everpiece username").fill(S);
  await payer.getByRole("button", { name: "Find" }).click();
  await payer.getByLabel(/This is the person I mean/).check();
  await payer.getByRole("button", { name: "Continue" }).click();
  await payer.getByRole("button", { name: "Confirm with fingerprint or screen lock" }).click();
  await expect(payer.getByText("is in Stella's balance now", { exact: false })).toBeVisible({ timeout: 120_000 });

  // the watcher sees it at finality and plans the run; Stella confirms
  const waiting = stella.getByLabel("Runs waiting for you");
  await expect.poll(async () => {
    await stella.reload();
    return waiting.count();
  }, { timeout: 180_000, intervals: [5_000] }).toBe(1);
  await expect(waiting).toContainText("Keep: $10.00");
  await expect(waiting).toContainText("Earn: $6.00 · Waiting for you");
  await expect(waiting).toContainText("NVIDIA: $0.00 · Skipped — $4.00 stays in your balance because no stock route meets Everpiece's price-quality rules");
  await waiting.getByRole("button", { name: "Confirm with fingerprint or screen lock" }).click();
  await expect(stella.getByText("Run finished: Partly done", { exact: false })).toBeVisible({ timeout: 180_000 });
  const past = stella.getByLabel("Past runs");
  await expect(past).toContainText("Earn: $6.00 · Done ✓");
  await expect(past).toContainText("Partly done");

  // the money: $14 in the balance, $6 earning (principal from the contract)
  await stella.goto("/");
  await expect(stella.locator(".balance")).toHaveText("$14.00");
  await stella.getByRole("link", { name: "Earn on your Dollars" }).click();
  await expect(stella.getByLabel("Your Earn position")).toContainText("Deposited$6.00");

  // pause: a newer signed version
  await stella.goto("/automate");
  const rule = stella.getByLabel("Rule Split my income");
  await rule.getByRole("button", { name: "Pause" }).click();
  await expect(rule).toContainText("Paused");

  expect(csp).toEqual([]);
});
