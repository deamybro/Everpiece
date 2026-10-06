// The last mile on the TESTNET stack (docs/PAYOUT.md), with its SIMULATED Paycrest: the bank list and the NGN rate are
// Paycrest's real public data; account names, the order, the deposit check and the bank payout are simulated.
// Recipient adds a verified bank account → requests ₦3,000 → payer pays in Dollars with one prompt → "Delivered"
// only once the provider confirms; a failing account is refunded to the payer. No @usernames needed.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const FAUCET = process.env.E2E_FAUCET_URL ?? "http://127.0.0.1:8790";

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
async function account(page: Page, first: string) {
  await page.goto("/");
  await page.getByLabel("Your first name").fill(first);
  await page.getByRole("button", { name: "Create my account with fingerprint or screen lock" }).click();
  await expect(page.getByText(`Hi ${first}, your Dollars`)).toBeVisible();
}
async function addBank(page: Page, number: string) {
  await page.goto("/");
  await page.getByRole("link", { name: "How you receive money" }).click();
  await expect(page.getByText("Simulated bank payouts", { exact: false })).toBeVisible();
  await page.getByText("Nigerian bank account", { exact: true }).click();
  await page.getByLabel("Bank", { exact: true }).selectOption({ label: "Guaranty Trust Bank" }); // Paycrest's real NGN list
  await page.getByLabel("Account number").fill(number); // checked automatically at 10 digits
  const check = page.getByLabel("Account check");
  await expect(check).toContainText(`TEST ACCOUNT ${number.slice(-4)} (SIMULATED)`);
  await check.getByRole("button", { name: /save with fingerprint/ }).click();
  await expect(page.getByLabel("Your bank account")).toContainText(`Guaranty Trust Bank ••${number.slice(-4)}`);
}
async function requestNaira(page: Page, naira: string): Promise<string> {
  await page.getByRole("link", { name: "Request money in naira" }).click();
  await page.getByRole("button", { name: "Naira to my bank" }).click();
  await page.getByLabel("Naira to receive").fill(naira);
  const sent = page.waitForRequest((r) => r.url().includes("/v1/payout/requests") && r.method() === "POST");
  await page.getByRole("button", { name: "Create request with fingerprint or screen lock" }).click();
  const id = (await sent).postDataJSON().request.requestId as string;
  await expect(page.getByRole("img", { name: "Payment request QR code" })).toBeVisible();
  return `/payout/${id}`;
}

test.afterEach(async ({ browser }) => {
  for (const c of browser.contexts()) await c.close();
});

test("₦3,000 to a verified bank account: one prompt, 'Delivered' only on the provider's confirmation; failures refunded", async ({ browser }) => {
  test.setTimeout(420_000);
  const maris = await withPasskeys(await browser.newContext());
  const payer = await withPasskeys(await browser.newContext());
  const csp: string[] = [];
  for (const p of [maris, payer]) p.on("console", (m) => m.type() === "error" && /Content Security Policy/.test(m.text()) && csp.push(m.text()));

  await account(maris, "Maris");
  await addBank(maris, "0123456789");
  const link = await requestNaira(maris, "3000");
  await expect(maris.getByText("You'll receive at least")).toBeVisible();

  await account(payer, "Payer");
  const address = await payer.evaluate(() => JSON.parse(localStorage.getItem("everpiece.account.v1")!).address as string);
  expect((await fetch(`${FAUCET}/faucet`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address }) })).ok).toBe(true);
  await payer.goto("/");
  await expect(payer.locator(".balance")).toHaveText("$100.00");

  await payer.goto(link);
  const summary = payer.getByLabel("Payout summary");
  await expect(summary).toContainText("receives at least");
  await expect(summary).toContainText("₦3,000");
  await expect(summary).toContainText("Guaranty Trust Bank ••6789");
  await expect(summary).toContainText("TEST ACCOUNT 6789 (SIMULATED)");
  await expect(payer.getByLabel("Payment summary")).toContainText("per Dollar");
  await payer.getByRole("button", { name: "Pay with fingerprint or screen lock" }).click();
  await expect(payer.getByText("Delivered to the bank account ✓")).toBeVisible({ timeout: 180_000 });
  await expect(maris.getByText("You received at least")).toBeVisible({ timeout: 60_000 });
  await expect(maris.getByLabel("Payout progress")).toContainText("Delivered");
  await expect(payer.getByLabel("Payout progress")).toContainText("Sent to the bank");

  // a bank payout that fails is refunded to the payer, and never shown as delivered
  const eve = await withPasskeys(await browser.newContext());
  await account(eve, "Eve");
  await addBank(eve, "2222222222");
  const failing = await requestNaira(eve, "2500");
  await payer.goto(failing);
  await payer.getByRole("button", { name: "Pay with fingerprint or screen lock" }).click();
  await expect(payer.getByText("The sender was refunded.", { exact: false })).toBeVisible({ timeout: 180_000 });
  await expect(payer.getByText("Delivered to the bank account ✓")).toHaveCount(0);

  // cash out: the payer adds their own bank, then sends ₦5,000 of their Dollars to it from Home
  await addBank(payer, "0987654321");
  await payer.goto("/");
  await payer.getByRole("link", { name: "Cash out to my bank" }).click();
  await expect(payer.getByLabel("Destination")).toContainText("Guaranty Trust Bank ••4321");
  await payer.getByRole("button", { name: "Continue" }).click();
  await payer.getByRole("button", { name: "₦5,000" }).click();
  await expect(payer.getByText(/≈ \$[0-9.]+ from your Dollars/)).toBeVisible();
  await payer.getByRole("button", { name: "Continue" }).click();
  await expect(payer.getByLabel("Payment summary")).toContainText("per Dollar");
  await payer.getByRole("button", { name: "Pay with fingerprint or screen lock" }).click();
  await expect(payer.getByLabel("Payout progress").getByText("Delivered")).toBeVisible();
  await expect(payer.locator(".timeline li.done").filter({ hasText: "Delivered" })).toBeVisible({ timeout: 180_000 });
  await payer.goto("/");
  const list = payer.getByLabel("Bank payouts");
  await expect(list).toContainText("Cash out · ₦5,000");
  await expect(list).toContainText("Delivered");

  expect(csp).toEqual([]);
});
